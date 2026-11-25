/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { permissionKeys } from "@/lib/permissions";
import type { WorkflowInput } from "@/lib/workflow-contracts";
import { ApiError } from "@/server/api-error";
import type { StaffContext } from "@/server/staff-context";
import { reconcileWorkflows } from "@/worker/workflow-jobs";

import {
  applyStandardWorkflows, createWorkflow, deleteWorkflow, duplicateWorkflow, listWorkflows,
  queueWorkflowTest, saveWorkflowSettings, updateWorkflow,
} from "./service";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const isLocal = (url: string | undefined) => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && parsed.pathname === "/kalendr_local";
};
const describeLocal = isLocal(runtimeUrl) && isLocal(ownerUrl) && isLocal(workerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

const input = (overrides: Partial<WorkflowInput> = {}): WorkflowInput => ({
  name: "Reminder", trigger: "before_start", offsetMinutes: 1440, active: true,
  filters: { serviceIds: [], locationIds: [], practitionerIds: [], bookingSources: [], deliveryModes: [] },
  steps: [{ channel: "email", subject: "Reminder", body: "Hi {customer_first_name}", templateKey: null, waitMinutes: 0, ignoreQuietHours: false, skipIfConfirmed: false }],
  ...overrides,
});

describeLocal("workflow settings service", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let tenantId = "";
  let otherTenantId = "";
  let userId = "";
  const context = (tenant: string, overrides: Partial<StaffContext> = {}): StaffContext => ({
    tenantId: tenant, clinicSlug: "x", clinicName: "X", role: "owner", permissions: [...permissionKeys],
    membershipId: null, userId, userName: "Owner", userEmail: "owner@example.com", preview: false, ...overrides,
  });

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    worker = postgres(workerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    const [tenant] = await owner<{ id: string }[]>`select id from tenants where slug = 'cedar-hair'`;
    const [other] = await owner<{ id: string }[]>`select id from tenants where slug = 'riverbend-care'`;
    tenantId = tenant!.id;
    otherTenantId = other!.id;
    const [member] = await owner<{ user_id: string }[]>`select user_id from memberships where tenant_id = ${tenantId} and role = 'owner' limit 1`;
    userId = member!.user_id;
  });

  afterAll(async () => {
    await owner`delete from workflows where tenant_id in (${tenantId}, ${otherTenantId})`;
    await owner`delete from workflow_settings where tenant_id in (${tenantId}, ${otherTenantId})`;
    await owner`delete from outbox_events where tenant_id = ${tenantId} and event_type = 'workflow.test'`;
    await owner`delete from idempotency_keys where tenant_id = ${tenantId} and route = 'staff.workflows.create'`;
    await Promise.all([owner.end(), worker.end()]);
  });

  it("starts empty, turns on the standard set once, and offers only channels that can send", async () => {
    const empty = await listWorkflows(context(tenantId));
    expect(empty.workflows).toEqual([]);
    expect(empty.unavailable).toBe(false);
    expect(empty.options.channels.find((channel) => channel.key === "email")?.ready).toBe(true);
    expect(empty.options.channels.find((channel) => channel.key === "whatsapp")).toMatchObject({ ready: false });
    expect(empty.options.services.length).toBeGreaterThan(0);

    const set = await applyStandardWorkflows(context(tenantId));
    expect(set.workflows.map((workflow) => workflow.presetKey).sort()).toEqual(["reminder_24h", "reminder_2h", "review_request", "video_link"]);
    expect(set.workflows.find((workflow) => workflow.presetKey === "reminder_24h")?.sentence).toMatch(/^24 hours before the/);
    expect((await applyStandardWorkflows(context(tenantId))).workflows).toHaveLength(4);
  });

  it("changes the 24-hour reminder to 48 hours, and a newly booked visit would use it", async () => {
    const { workflows } = await listWorkflows(context(tenantId));
    const reminder = workflows.find((workflow) => workflow.presetKey === "reminder_24h")!;
    const updated = await updateWorkflow(context(tenantId), reminder.id, {
      ...input({ name: reminder.name, offsetMinutes: 2880, steps: reminder.steps }), expectedVersion: reminder.version,
    });
    expect(updated.offsetMinutes).toBe(2880);
    expect(updated.version).toBe(reminder.version + 1);
    expect(updated.sentence).toMatch(/^48 hours before/);
    const [row] = await owner<{ offset_minutes: number }[]>`select offset_minutes from workflows where id = ${reminder.id}`;
    expect(row!.offset_minutes).toBe(2880);
  });

  it("refuses a stale save with version_conflict", async () => {
    const { workflows } = await listWorkflows(context(tenantId));
    const reminder = workflows.find((workflow) => workflow.presetKey === "reminder_2h")!;
    await expect(updateWorkflow(context(tenantId), reminder.id, { ...input({ steps: reminder.steps }), expectedVersion: reminder.version + 5 }))
      .rejects.toMatchObject({ code: "version_conflict", status: 409 });
  });

  it("answers a repeated create with the same workflow, not a second one", async () => {
    const key = `key-${randomUUID()}`;
    const first = await createWorkflow(context(tenantId), input({ name: "Once" }), key);
    const second = await createWorkflow(context(tenantId), input({ name: "Once" }), key);
    expect(second.id).toBe(first.id);
    const [count] = await owner<{ count: number }[]>`select count(*)::integer as count from workflows where tenant_id = ${tenantId} and name = 'Once'`;
    expect(count!.count).toBe(1);
  });

  it("refuses a filter that points at another business's service", async () => {
    const [foreign] = await owner<{ id: string }[]>`select id from services where tenant_id = ${otherTenantId} limit 1`;
    await expect(createWorkflow(context(tenantId), input({ filters: { serviceIds: [foreign!.id], locationIds: [], practitionerIds: [], bookingSources: [], deliveryModes: [] } })))
      .rejects.toBeInstanceOf(ApiError);
  });

  it("duplicates switched off, deletes, and queues a test only for the signed-in person", async () => {
    const created = await createWorkflow(context(tenantId), input({ name: "Source" }));
    const copy = await duplicateWorkflow(context(tenantId), created.id);
    expect(copy).toMatchObject({ name: "Source (copy)", active: false });
    expect(copy.steps[0]!.body).toBe(created.steps[0]!.body);

    await expect(queueWorkflowTest(context(tenantId), created.id)).resolves.toEqual({ queued: true });
    const [event] = await owner<{ payload: { userId: string; workflowId: string } }[]>`
      select payload from outbox_events where tenant_id = ${tenantId} and event_type = 'workflow.test' order by created_at desc limit 1
    `;
    expect(event!.payload).toEqual({ workflowId: created.id, userId });

    await deleteWorkflow(context(tenantId), copy.id);
    await expect(deleteWorkflow(context(tenantId), copy.id)).rejects.toMatchObject({ code: "workflow_not_found" });
  });

  it("keeps workflows inside their business and asks for the settings permission", async () => {
    const { workflows } = await listWorkflows(context(tenantId));
    await expect(updateWorkflow(context(otherTenantId), workflows[0]!.id, { ...input(), expectedVersion: 1 })).rejects.toMatchObject({ code: "workflow_not_found" });
    await expect(listWorkflows(context(tenantId, { role: "receptionist", permissions: ["appointments.book"] }))).rejects.toMatchObject({ status: 403 });
    await expect(listWorkflows(context(tenantId, { preview: true }))).resolves.toMatchObject({ unavailable: true, workflows: [] });
  });

  it("saves quiet hours and the worker re-plans after any edit", async () => {
    await saveWorkflowSettings(context(tenantId), { quietStartMinute: 22 * 60, quietEndMinute: 7 * 60 });
    expect((await listWorkflows(context(tenantId))).settings).toEqual({ quietStartMinute: 1320, quietEndMinute: 420 });
    const [flagged] = await owner<{ reconciled_at: Date | null }[]>`select reconciled_at from workflow_settings where tenant_id = ${tenantId}`;
    expect(flagged!.reconciled_at).toBeNull();
    const result = await reconcileWorkflows(worker);
    expect(result.tenants).toBeGreaterThanOrEqual(1);
    const [done] = await owner<{ reconciled_at: Date | null }[]>`select reconciled_at from workflow_settings where tenant_id = ${tenantId}`;
    expect(done!.reconciled_at).not.toBeNull();
    expect((await reconcileWorkflows(worker)).tenants).toBe(0);
  });

  it("lets the worker find businesses only through the definer function, which returns ids", async () => {
    await owner`update workflow_settings set reconciled_at = null where tenant_id = ${tenantId}`;
    const rows = await worker<{ id: string }[]>`select * from kalendr_workflow_tenants('workflow_reconcile') as id`;
    expect(rows.map((row) => Object.values(row)[0])).toContain(tenantId);
  });
});
