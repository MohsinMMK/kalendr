import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents, locations, outboxEvents, practitioners, services, workflowSettings, workflows, workflowSteps } from "@/db/schema";
import { isBusinessTypeId, defaultBusinessType } from "@/lib/business-types";
import {
  DEFAULT_QUIET_END_MINUTE,
  DEFAULT_QUIET_START_MINUTE,
  describeWorkflow,
  type WorkflowFilters,
  type WorkflowInput,
  type WorkflowListView,
  type WorkflowSettings,
  type WorkflowStepView,
  type WorkflowTrigger,
  type WorkflowView,
  workflowTemplateKeys,
} from "@/lib/workflow-contracts";
import { workflowPresetsFor } from "@/lib/workflow-presets";
import { profileWords, resolveBusinessProfile } from "@/lib/terminology";
import { tenants } from "@/db/schema";

import { ApiError } from "../api-error";
import { claimKey, finishKey } from "../idempotent";
import { currentTraceParent } from "../tracing";
import { can, type StaffContext } from "../staff-context";
import { workflowChannelStatuses } from "./channels";
import { applyWorkflowPresets } from "./presets";
import { drizzleRunner } from "./runner";

const BOOKING_SOURCES = [
  { key: "online", label: "Booking page" },
  { key: "widget", label: "Website widget" },
  { key: "iframe", label: "Embedded page" },
  { key: "staff", label: "Booked by staff" },
  { key: "phone", label: "Phone" },
  { key: "walk_in", label: "Walk-in" },
  { key: "recall", label: "Recall" },
  { key: "waitlist", label: "Waitlist" },
  { key: "assistant", label: "Booking assistant" },
];

function requireManage(context: StaffContext): void {
  if (!can(context, "settings.manage")) throw new ApiError(403, "forbidden", "You don't have permission to change business settings.");
}

function emptyFilters(value: unknown): WorkflowFilters {
  const record = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const list = (key: string) => (Array.isArray(record[key]) ? (record[key] as unknown[]).filter((item): item is string => typeof item === "string") : []);
  return { serviceIds: list("serviceIds"), locationIds: list("locationIds"), practitionerIds: list("practitionerIds"), bookingSources: list("bookingSources"), deliveryModes: list("deliveryModes").filter((mode): mode is "in_person" | "video" | "phone" => mode === "in_person" || mode === "video" || mode === "phone") };
}

async function appointmentWord(transaction: KalendrTransaction, tenantId: string): Promise<string> {
  const [tenant] = await transaction.select({ businessType: tenants.businessType, terminology: tenants.terminology, features: tenants.features })
    .from(tenants).where(eq(tenants.id, tenantId));
  return profileWords(resolveBusinessProfile({
    businessType: tenant?.businessType ?? defaultBusinessType, terminology: tenant?.terminology, features: tenant?.features,
  })).appointment;
}

/** Reminders first, longest lead first; then follow-ups; then the rest in the order they were made. */
const DISPLAY_RANK: Record<string, number> = { before_start: 0, form_missing: 1, after_end: 2 };
function compareForDisplay(a: { trigger: string; offsetMinutes: number }, b: { trigger: string; offsetMinutes: number }): number {
  const rank = (DISPLAY_RANK[a.trigger] ?? 3) - (DISPLAY_RANK[b.trigger] ?? 3);
  return rank !== 0 ? rank : a.trigger === b.trigger ? b.offsetMinutes - a.offsetMinutes : 0;
}

async function loadViews(transaction: KalendrTransaction, tenantId: string, word: string, onlyId?: string): Promise<WorkflowView[]> {
  const rows = await transaction.select().from(workflows)
    .where(onlyId ? and(eq(workflows.tenantId, tenantId), eq(workflows.id, onlyId)) : eq(workflows.tenantId, tenantId))
    .orderBy(asc(workflows.createdAt), asc(workflows.id));
  rows.sort(compareForDisplay);
  if (rows.length === 0) return [];
  const steps = await transaction.select().from(workflowSteps)
    .where(and(eq(workflowSteps.tenantId, tenantId), inArray(workflowSteps.workflowId, rows.map((row) => row.id))))
    .orderBy(asc(workflowSteps.position));
  return rows.map((row) => {
    const own: WorkflowStepView[] = steps.filter((step) => step.workflowId === row.id).map((step) => ({
      id: step.id,
      channel: step.channel as WorkflowStepView["channel"],
      subject: step.subject,
      body: step.body,
      templateKey: workflowTemplateKeys.find((key) => key === step.templateKey) ?? null,
      waitMinutes: step.waitMinutes,
      ignoreQuietHours: step.ignoreQuietHours,
      skipIfConfirmed: step.skipIfConfirmed,
    }));
    const trigger = row.trigger as WorkflowTrigger;
    return {
      id: row.id,
      name: row.name,
      trigger,
      offsetMinutes: row.offsetMinutes,
      filters: emptyFilters(row.filters),
      active: row.active,
      version: row.version,
      presetKey: row.presetKey,
      steps: own,
      sentence: describeWorkflow({ trigger, offsetMinutes: row.offsetMinutes, steps: own }, word),
    };
  });
}

function unavailableView(): WorkflowListView {
  return {
    workflows: [],
    settings: { quietStartMinute: DEFAULT_QUIET_START_MINUTE, quietEndMinute: DEFAULT_QUIET_END_MINUTE },
    options: { services: [], locations: [], practitioners: [], bookingSources: BOOKING_SOURCES, channels: workflowChannelStatuses() },
    unavailable: true,
  };
}

export async function listWorkflows(context: StaffContext): Promise<WorkflowListView> {
  requireManage(context);
  if (context.preview) return unavailableView();
  return withTenant(context.tenantId, async (transaction) => {
    const word = await appointmentWord(transaction, context.tenantId);
    const [views, settings, serviceRows, locationRows, practitionerRows] = await Promise.all([
      loadViews(transaction, context.tenantId, word),
      transaction.select().from(workflowSettings).where(eq(workflowSettings.tenantId, context.tenantId)),
      transaction.select({ id: services.id, name: services.name }).from(services).where(and(eq(services.tenantId, context.tenantId), eq(services.isActive, true))).orderBy(asc(services.name)),
      transaction.select({ id: locations.id, name: locations.name }).from(locations).where(and(eq(locations.tenantId, context.tenantId), eq(locations.isActive, true))).orderBy(asc(locations.name)),
      transaction.select({ id: practitioners.id, name: practitioners.name }).from(practitioners).where(eq(practitioners.tenantId, context.tenantId)).orderBy(asc(practitioners.name)),
    ]);
    const setting = settings[0];
    return {
      workflows: views,
      settings: {
        quietStartMinute: setting?.quietStartMinute ?? DEFAULT_QUIET_START_MINUTE,
        quietEndMinute: setting?.quietEndMinute ?? DEFAULT_QUIET_END_MINUTE,
      },
      options: { services: serviceRows, locations: locationRows, practitioners: practitionerRows, bookingSources: BOOKING_SOURCES, channels: workflowChannelStatuses() },
      unavailable: false,
    };
  });
}

/** Marks the business's workflows as changed so the worker re-plans every upcoming booking. */
async function markChanged(transaction: KalendrTransaction, tenantId: string): Promise<void> {
  await transaction.insert(workflowSettings).values({ tenantId }).onConflictDoUpdate({
    target: workflowSettings.tenantId,
    set: { reconciledAt: null, updatedAt: sql`now()` },
  });
}

async function audit(transaction: KalendrTransaction, context: StaffContext, action: string, workflowId: string): Promise<void> {
  // Ids only: the name and the message text are free text and stay out of the activity log.
  await transaction.insert(auditEvents).values({
    tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action, outcome: "success", metadata: { workflowId },
  });
}

/** Refuses ids that don't belong to this business, so a filter can't point at someone else's service. */
async function checkFilters(transaction: KalendrTransaction, tenantId: string, filters: WorkflowFilters): Promise<void> {
  const checks: Array<[string[], Promise<{ id: string }[]>, string]> = [
    [filters.serviceIds, filters.serviceIds.length ? transaction.select({ id: services.id }).from(services).where(and(eq(services.tenantId, tenantId), inArray(services.id, filters.serviceIds))) : Promise.resolve([]), "serviceIds"],
    [filters.locationIds, filters.locationIds.length ? transaction.select({ id: locations.id }).from(locations).where(and(eq(locations.tenantId, tenantId), inArray(locations.id, filters.locationIds))) : Promise.resolve([]), "locationIds"],
    [filters.practitionerIds, filters.practitionerIds.length ? transaction.select({ id: practitioners.id }).from(practitioners).where(and(eq(practitioners.tenantId, tenantId), inArray(practitioners.id, filters.practitionerIds))) : Promise.resolve([]), "practitionerIds"],
  ];
  for (const [wanted, found, field] of checks) {
    if ((await found).length !== new Set(wanted).size) {
      throw new ApiError(400, "validation_error", "One of the choices in “Only for…” no longer exists. Reload and pick again.", { [`filters.${field}`]: ["Pick from the list."] });
    }
  }
}

async function writeSteps(transaction: KalendrTransaction, tenantId: string, workflowId: string, steps: WorkflowInput["steps"]): Promise<void> {
  await transaction.insert(workflowSteps).values(steps.map((step, position) => ({
    tenantId, workflowId, position, channel: step.channel, subject: step.subject, body: step.body, templateKey: step.templateKey,
    waitMinutes: step.waitMinutes, ignoreQuietHours: step.ignoreQuietHours, skipIfConfirmed: step.skipIfConfirmed,
  })));
}

/**
 * Brings a workflow's steps in line with an edit, keeping each step's id by position. Messages already sent
 * or waiting stay attached to their step (a rename never sends a follow-up again); only a step that is removed
 * takes its messages with it.
 */
async function syncSteps(transaction: KalendrTransaction, tenantId: string, workflowId: string, steps: WorkflowInput["steps"]): Promise<void> {
  const existing = await transaction.select({ id: workflowSteps.id, position: workflowSteps.position }).from(workflowSteps)
    .where(and(eq(workflowSteps.tenantId, tenantId), eq(workflowSteps.workflowId, workflowId)));
  const byPosition = new Map(existing.map((step) => [step.position, step.id]));
  for (const [position, step] of steps.entries()) {
    const values = {
      channel: step.channel, subject: step.subject, body: step.body, templateKey: step.templateKey,
      waitMinutes: step.waitMinutes, ignoreQuietHours: step.ignoreQuietHours, skipIfConfirmed: step.skipIfConfirmed,
    };
    const stepId = byPosition.get(position);
    if (stepId) await transaction.update(workflowSteps).set(values).where(and(eq(workflowSteps.tenantId, tenantId), eq(workflowSteps.id, stepId)));
    else await transaction.insert(workflowSteps).values({ tenantId, workflowId, position, ...values });
  }
  const removed = existing.filter((step) => step.position >= steps.length).map((step) => step.id);
  if (removed.length > 0) await transaction.delete(workflowSteps).where(and(eq(workflowSteps.tenantId, tenantId), inArray(workflowSteps.id, removed)));
}

export async function createWorkflow(context: StaffContext, input: WorkflowInput, idempotencyKey?: string): Promise<WorkflowView> {
  requireManage(context);
  if (context.preview) throw new ApiError(409, "preview_unavailable", "Reminders can't be saved in the preview.");
  return withTenant(context.tenantId, async (transaction) => {
    // A double click sends the same key twice; the second gets the first one's answer instead of a duplicate.
    const claim = idempotencyKey ? await claimKey<WorkflowView>(transaction, context.tenantId, "staff.workflows.create", idempotencyKey, input) : null;
    if (claim && "replay" in claim) return claim.replay;
    await checkFilters(transaction, context.tenantId, input.filters);
    const [row] = await transaction.insert(workflows).values({
      tenantId: context.tenantId, name: input.name, trigger: input.trigger, offsetMinutes: input.offsetMinutes,
      filters: input.filters, active: input.active,
    }).returning({ id: workflows.id });
    if (!row) throw new Error("Workflow insert did not return a row");
    await writeSteps(transaction, context.tenantId, row.id, input.steps);
    await markChanged(transaction, context.tenantId);
    await audit(transaction, context, "workflow.created", row.id);
    const [view] = await loadViews(transaction, context.tenantId, await appointmentWord(transaction, context.tenantId), row.id);
    if (!view) throw new Error("Workflow vanished after insert");
    if (claim && "claimId" in claim) await finishKey(transaction, claim.claimId, view);
    return view;
  });
}

export async function updateWorkflow(context: StaffContext, id: string, input: WorkflowInput & { expectedVersion: number }): Promise<WorkflowView> {
  requireManage(context);
  if (context.preview) throw new ApiError(409, "preview_unavailable", "Reminders can't be saved in the preview.");
  return withTenant(context.tenantId, async (transaction) => {
    await checkFilters(transaction, context.tenantId, input.filters);
    const updated = await transaction.update(workflows).set({
      name: input.name, trigger: input.trigger, offsetMinutes: input.offsetMinutes, filters: input.filters,
      active: input.active, version: sql`${workflows.version} + 1`, updatedAt: sql`now()`,
    }).where(and(eq(workflows.tenantId, context.tenantId), eq(workflows.id, id), eq(workflows.version, input.expectedVersion)))
      .returning({ id: workflows.id });
    if (updated.length === 0) {
      const [exists] = await transaction.select({ id: workflows.id }).from(workflows).where(and(eq(workflows.tenantId, context.tenantId), eq(workflows.id, id)));
      if (!exists) throw new ApiError(404, "workflow_not_found", "That workflow is already gone.");
      throw new ApiError(409, "version_conflict", "Someone else changed this workflow. Reload to see their changes.");
    }
    await syncSteps(transaction, context.tenantId, id, input.steps);
    await markChanged(transaction, context.tenantId);
    await audit(transaction, context, "workflow.updated", id);
    const [view] = await loadViews(transaction, context.tenantId, await appointmentWord(transaction, context.tenantId), id);
    if (!view) throw new Error("Workflow vanished after update");
    return view;
  });
}

export async function deleteWorkflow(context: StaffContext, id: string): Promise<{ id: string }> {
  requireManage(context);
  if (context.preview) return { id };
  return withTenant(context.tenantId, async (transaction) => {
    const removed = await transaction.delete(workflows).where(and(eq(workflows.tenantId, context.tenantId), eq(workflows.id, id))).returning({ id: workflows.id });
    if (removed.length === 0) throw new ApiError(404, "workflow_not_found", "That workflow is already gone.");
    await markChanged(transaction, context.tenantId);
    await audit(transaction, context, "workflow.deleted", id);
    return { id };
  });
}

export async function duplicateWorkflow(context: StaffContext, id: string): Promise<WorkflowView> {
  requireManage(context);
  if (context.preview) throw new ApiError(409, "preview_unavailable", "Reminders can't be saved in the preview.");
  return withTenant(context.tenantId, async (transaction) => {
    const word = await appointmentWord(transaction, context.tenantId);
    const [source] = await loadViews(transaction, context.tenantId, word, id);
    if (!source) throw new ApiError(404, "workflow_not_found", "That workflow is already gone.");
    const [row] = await transaction.insert(workflows).values({
      tenantId: context.tenantId, name: `${source.name} (copy)`.slice(0, 160), trigger: source.trigger,
      offsetMinutes: source.offsetMinutes, filters: source.filters, active: false,
    }).returning({ id: workflows.id });
    if (!row) throw new Error("Workflow insert did not return a row");
    await writeSteps(transaction, context.tenantId, row.id, source.steps);
    await markChanged(transaction, context.tenantId);
    await audit(transaction, context, "workflow.created", row.id);
    const [view] = await loadViews(transaction, context.tenantId, word, row.id);
    if (!view) throw new Error("Workflow vanished after duplicate");
    return view;
  });
}

/** Queues a test to the signed-in person only. The worker sends it; nothing leaves the request. */
export async function queueWorkflowTest(context: StaffContext, id: string): Promise<{ queued: true }> {
  requireManage(context);
  if (context.preview) throw new ApiError(409, "preview_unavailable", "Test messages can't be sent in the preview.");
  if (!context.userId) throw new ApiError(400, "no_recipient", "Sign in with your own account to send yourself a test.");
  const userId = context.userId;
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.select({ id: workflows.id }).from(workflows).where(and(eq(workflows.tenantId, context.tenantId), eq(workflows.id, id)));
    if (!row) throw new ApiError(404, "workflow_not_found", "That workflow is already gone.");
    await transaction.insert(outboxEvents).values({
      tenantId: context.tenantId, aggregateType: "workflow", aggregateId: id, eventType: "workflow.test",
      payload: { workflowId: id, userId },
      dedupeKey: `workflow.test:${id}:${crypto.randomUUID()}`,
      traceParent: currentTraceParent(),
    });
    return { queued: true as const };
  });
}

export async function saveWorkflowSettings(context: StaffContext, input: WorkflowSettings): Promise<WorkflowSettings> {
  requireManage(context);
  if (context.preview) throw new ApiError(409, "preview_unavailable", "Quiet hours can't be saved in the preview.");
  return withTenant(context.tenantId, async (transaction) => {
    await transaction.insert(workflowSettings).values({ tenantId: context.tenantId, quietStartMinute: input.quietStartMinute, quietEndMinute: input.quietEndMinute })
      .onConflictDoUpdate({
        target: workflowSettings.tenantId,
        set: { quietStartMinute: input.quietStartMinute, quietEndMinute: input.quietEndMinute, reconciledAt: null, updatedAt: sql`now()` },
      });
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "workflow.quiet_hours_changed", outcome: "success", metadata: {},
    });
    return input;
  });
}

/** The empty state's "Turn on the standard set". Safe to press twice. */
export async function applyStandardWorkflows(context: StaffContext): Promise<WorkflowListView> {
  requireManage(context);
  if (context.preview) throw new ApiError(409, "preview_unavailable", "Reminders can't be saved in the preview.");
  await withTenant(context.tenantId, async (transaction) => {
    const [tenant] = await transaction.select({ businessType: tenants.businessType }).from(tenants).where(eq(tenants.id, context.tenantId));
    const type = isBusinessTypeId(tenant?.businessType) ? tenant.businessType : defaultBusinessType;
    await applyWorkflowPresets(drizzleRunner(transaction), context.tenantId, type);
    await audit(transaction, context, "workflow.standard_set_applied", `preset:${workflowPresetsFor(type).length}`);
  });
  return listWorkflows(context);
}
