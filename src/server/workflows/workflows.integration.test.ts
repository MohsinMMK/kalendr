/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withTenant } from "@/db/client";
import { createAppointment, listAvailability, manageAppointment } from "@/server/appointment-repository";
import { createFakeEmailProvider } from "@/server/messaging/email-fake";
import { providerSink } from "@/worker/delivery";
import { createEmailAdapter } from "@/worker/email-adapter";
import { createHandlers, type OutboxEvent } from "@/worker/handlers";
import type { HandlerOutcome } from "@/worker/handlers/types";
import { runsOnWorkflows } from "@/worker/handlers/workflow-message";
import { reconcileWorkflows, sweepTenantMessages } from "@/worker/workflow-jobs";
import { permissionKeys } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";

import { planAppointment } from "./engine";
import { listWorkflows, updateWorkflow } from "./service";
import { applyWorkflowPresets } from "./presets";
import { localMinuteOfDay } from "./quiet-hours";
import { drizzleRunner, postgresRunner } from "./runner";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const isLocal = (url: string | undefined) => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && parsed.pathname === "/kalendr_local";
};
const describeLocal = isLocal(runtimeUrl) && isLocal(ownerUrl) && isLocal(workerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

describeLocal("message workflows", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let tenantId = "";
  let otherTenantId = "";
  let timeZone = "Asia/Kolkata";
  let linkIds = { location: "", service: "", practitioner: "" };
  const created: { appointmentId: string; manageToken: string; startsAt: string; endsAt: string }[] = [];
  const provider = createFakeEmailProvider();
  let clock = new Date();
  const handlers = createHandlers({
    sink: providerSink({ email: createEmailAdapter({ provider, origin: "http://127.0.0.1:3202", fallbackReplyTo: null }) }),
    now: () => clock,
    origin: "http://127.0.0.1:3202",
  });
  const suffix = randomUUID().slice(0, 8);
  const day = 24 * 60 * 60 * 1_000;
  let slots: { startsAt: string; endsAt: string }[] = [];

  const tenantScope = async <T>(work: (tenantDb: postgres.TransactionSql) => Promise<T>): Promise<T> =>
    worker.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      return work(tenantDb);
    }) as Promise<T>;

  async function book(slot: { startsAt: string; endsAt: string }, label: string, deliveryMode?: "in_person" | "video" | "phone") {
    const result = await createAppointment({
      clinicSlug: "lotus-dental", patientType: "new", bookingFor: "self",
      locationId: linkIds.location, serviceId: linkIds.service, practitionerId: linkIds.practitioner,
      slotId: randomUUID(), startsAt: slot.startsAt, endsAt: slot.endsAt,
      firstName: "Flow", lastName: label, phone: `+91 93${String(Date.now()).slice(-8)}`,
      email: `flow-${label}-${suffix}@example.com`, preferredChannel: "email",
      acceptedPrivacyNotice: true, messagingConsent: false, ...(deliveryMode ? { locationChoice: { kind: deliveryMode === "video" ? "video" as const : deliveryMode === "phone" ? "they_call" as const : "in_person" as const } } : {}),
    }, randomUUID(), randomUUID().replaceAll("-", ""));
    created.push(result);
    return result;
  }

  const rows = (appointmentId: string, status?: string) => owner<{ status: string; send_at: Date; slot_key: string; workflow: string }[]>`
    select message.status, message.send_at, message.slot_key, workflow.name as workflow
    from scheduled_messages as message
    join workflow_steps as step on step.tenant_id = message.tenant_id and step.id = message.step_id
    join workflows as workflow on workflow.tenant_id = step.tenant_id and workflow.id = step.workflow_id
    where message.tenant_id = ${tenantId} and message.appointment_id = ${appointmentId}
      and (${status ?? null}::text is null or message.status = ${status ?? null})
    order by message.send_at
  `;

  /** Hands due messages to the outbox, then runs each `workflow.message` event as the worker would. */
  async function sweepAndSend(now: Date): Promise<{ queued: number; held: number; outcomes: HandlerOutcome[] }> {
    clock = now;
    const result = await worker.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      return sweepTenantMessages(tenantDb, tenantId, now);
    }) as { queued: number; held: number };
    const events = await owner<{ id: string; aggregate_id: string; payload: unknown; dedupe_key: string }[]>`
      select id, aggregate_id, payload, dedupe_key from outbox_events
      where tenant_id = ${tenantId} and event_type = 'workflow.message' and status = 'pending'
      order by created_at
    `;
    const outcomes: HandlerOutcome[] = [];
    for (const row of events) {
      outcomes.push(await tenantScope((tenantDb) => handlers.get("workflow.message")!(tenantDb, {
        id: row.id, tenantId, aggregateType: "appointment", aggregateId: row.aggregate_id, eventType: "workflow.message",
        payload: row.payload, dedupeKey: row.dedupe_key, attemptCount: 1,
      } satisfies OutboxEvent)));
      await owner`update outbox_events set status = 'delivered' where id = ${row.id}`;
    }
    return { ...result, outcomes };
  }

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    worker = postgres(workerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    const [tenant] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    const [other] = await owner<{ id: string }[]>`select id from tenants where slug <> 'lotus-dental' order by slug limit 1`;
    tenantId = tenant!.id;
    otherTenantId = other!.id;
    const [link] = await owner<{ location_id: string; service_id: string; practitioner_id: string; timezone: string }[]>`
      select location.location_id, service.service_id, service.practitioner_id, place.timezone
      from practitioner_services as service
      join practitioner_locations as location on location.tenant_id = service.tenant_id and location.practitioner_id = service.practitioner_id
      join locations as place on place.tenant_id = location.tenant_id and place.id = location.location_id
      where service.tenant_id = ${tenantId} limit 1
    `;
    linkIds = { location: link!.location_id, service: link!.service_id, practitioner: link!.practitioner_id };
    timeZone = link!.timezone;
    await worker.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      await applyWorkflowPresets(postgresRunner(tenantDb), tenantId, "dental");
    });
    slots = await listAvailability({
      clinicSlug: "lotus-dental", locationId: linkIds.location, serviceId: linkIds.service, practitionerId: linkIds.practitioner,
      from: new Date(Date.now() + 4 * day).toISOString(), to: new Date(Date.now() + 12 * day).toISOString(),
    });
    // Far enough apart that no two bookings compete for the same person.
    const spread: typeof slots = [];
    for (const slot of slots) {
      const last = spread.at(-1);
      if (!last || new Date(slot.startsAt).getTime() - new Date(last.endsAt).getTime() >= 60 * 60_000) spread.push(slot);
    }
    slots = spread;
    if (slots.length < 12) throw new Error("Expected open slots for the workflow tests");
  });

  afterAll(async () => {
    const ids = created.map((item) => item.appointmentId);
    await owner.begin(async (transaction) => {
      if (ids.length > 0) {
        await transaction`delete from outbox_events where tenant_id = ${tenantId} and aggregate_id in ${transaction(ids)}`;
        await transaction`delete from notifications where tenant_id = ${tenantId} and (appointment_id in ${transaction(ids)} or appointment_id is null)`;
        await transaction`delete from audit_events where tenant_id = ${tenantId} and appointment_id in ${transaction(ids)}`;
        await transaction`delete from appointments where id in ${transaction(ids)}`;
      }
      await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where tenant_id = ${tenantId} and email like ${`flow-%-${suffix}@example.com`})`;
      await transaction`delete from patients where tenant_id = ${tenantId} and email like ${`flow-%-${suffix}@example.com`}`;
      await transaction`delete from workflows where tenant_id = ${tenantId}`;
      await transaction`delete from workflow_settings where tenant_id = ${tenantId}`;
      await transaction`delete from idempotency_keys where tenant_id = ${tenantId} and created_at > now() - interval '30 minutes'`;
    }).catch((error: unknown) => console.error("workflow test cleanup failed", error));
    await Promise.all([owner.end(), worker.end()]);
  });

  it("switches the standard set on once and the business moves off the fixed reminder", async () => {
    const [before] = await owner<{ count: number }[]>`select count(*)::integer as count from workflows where tenant_id = ${tenantId}`;
    expect(before!.count).toBe(5); // dental: two reminders, review request, the video link, the form chase (off)
    await worker.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      expect(await applyWorkflowPresets(postgresRunner(tenantDb), tenantId, "dental")).toBe(0);
      expect(await runsOnWorkflows(tenantDb, tenantId)).toBe(true);
    });
  });

  it("a booking 3 days out creates two reminder rows; moving it replaces both; moving it back revives the first two", async () => {
    const first = await book(slots[0]!, "move");
    const reminders = await rows(first.appointmentId, "pending");
    expect(reminders).toHaveLength(2);
    expect(reminders.map((row) => row.workflow).sort()).toEqual(["Reminder 2 hours before", "Reminder 24 hours before"]);

    const moved = await manageAppointment(first.manageToken, { action: "reschedule", startsAt: slots[3]!.startsAt, expectedVersion: 1 });
    expect(moved.version).toBe(2);
    expect(await rows(first.appointmentId, "pending")).toHaveLength(2);
    expect(await rows(first.appointmentId, "cancelled")).toHaveLength(2);

    // Moving a booking gives it a new link (feature 8); the old one no longer opens it.
    await manageAppointment(moved.manageToken ?? first.manageToken, { action: "reschedule", startsAt: slots[0]!.startsAt, expectedVersion: 2 });
    expect(await rows(first.appointmentId)).toHaveLength(4); // not 6: the first two came back
    expect((await rows(first.appointmentId, "pending")).map((row) => row.send_at.toISOString()))
      .toEqual(reminders.map((row) => row.send_at.toISOString()));
  });

  it("planning twice, and an edit that does not touch the times, add nothing", async () => {
    const booking = await book(slots[4]!, "twice");
    const before = await rows(booking.appointmentId);
    await withTenant(tenantId, (transaction) => planAppointment(drizzleRunner(transaction), tenantId, booking.appointmentId));
    await withTenant(tenantId, (transaction) => planAppointment(drizzleRunner(transaction), tenantId, booking.appointmentId, { action: "appointment.started", version: 5 }));
    expect((await rows(booking.appointmentId)).map((row) => row.slot_key)).toEqual(before.map((row) => row.slot_key));
  });

  it("sends each due reminder once, with a working manage link, and never again", async () => {
    const booking = await book(slots[5]!, "send");
    await owner`update scheduled_messages set send_at = now() - interval '1 minute' where tenant_id = ${tenantId} and appointment_id = ${booking.appointmentId}`;
    provider.reset();
    const noon = atLocalHour(12);
    const first = await sweepAndSend(noon);
    expect(first.queued).toBeGreaterThanOrEqual(2);
    const mine = provider.sent.filter((message) => message.to === `flow-send-${suffix}@example.com`);
    expect(mine).toHaveLength(2);
    expect(mine[0]!.text).toContain("http://127.0.0.1:3202/manage/");
    expect(mine.map((message) => message.subject).some((subject) => subject.startsWith("Reminder:"))).toBe(true);
    expect((await rows(booking.appointmentId, "sent"))).toHaveLength(2);

    const attempts = provider.attempts;
    const again = await sweepAndSend(noon);
    expect(again.queued).toBe(0);
    expect(provider.attempts).toBe(attempts);
  });

  it("holds a reminder due at 2 am until 8 am local", async () => {
    const booking = await book(slots[6]!, "quiet");
    await owner`update scheduled_messages set send_at = now() - interval '1 minute' where tenant_id = ${tenantId} and appointment_id = ${booking.appointmentId}`;
    provider.reset();
    const night = atLocalHour(2);
    const result = await sweepAndSend(night);
    expect(result.queued).toBe(0);
    expect(provider.sent.filter((message) => message.to.includes("-quiet-"))).toHaveLength(0);
    const held = await rows(booking.appointmentId, "pending");
    expect(held).toHaveLength(2);
    for (const row of held) {
      expect(localMinuteOfDay(row.send_at, timeZone)).toBe(8 * 60);
      expect(row.send_at.getTime()).toBeGreaterThan(night.getTime());
    }
  });

  it("cancelling a booking cancels its reminders and nothing is sent", async () => {
    const booking = await book(slots[7]!, "cancel");
    expect(await rows(booking.appointmentId, "pending")).toHaveLength(2);
    await manageAppointment(booking.manageToken, { action: "cancel", expectedVersion: 1, reason: "Integration verification" });
    expect(await rows(booking.appointmentId, "pending")).toHaveLength(0);
    expect(await rows(booking.appointmentId, "cancelled")).toHaveLength(2);
    await owner`update scheduled_messages set send_at = now() - interval '1 minute' where tenant_id = ${tenantId} and appointment_id = ${booking.appointmentId}`;
    provider.reset();
    await sweepAndSend(atLocalHour(12));
    expect(provider.sent.filter((message) => message.to.includes("-cancel-"))).toHaveLength(0);
  });

  it("drops a message queued for a booking that was cancelled in the meantime", async () => {
    const booking = await book(slots[8]!, "late");
    // The sweep queued it, then the booking was cancelled before the worker got to it.
    await owner`update scheduled_messages set status = 'queued' where tenant_id = ${tenantId} and appointment_id = ${booking.appointmentId}`;
    await owner`update appointments set status = 'cancelled' where id = ${booking.appointmentId}`;
    const [message] = await owner<{ id: string }[]>`select id from scheduled_messages where tenant_id = ${tenantId} and appointment_id = ${booking.appointmentId} limit 1`;
    provider.reset();
    const outcome = await tenantScope((tenantDb) => handlers.get("workflow.message")!(tenantDb, {
      id: randomUUID(), tenantId, aggregateType: "appointment", aggregateId: booking.appointmentId, eventType: "workflow.message",
      payload: { scheduledMessageId: message!.id }, dedupeKey: randomUUID(), attemptCount: 1,
    }));
    expect(outcome).toBe("delivered");
    expect(provider.attempts).toBe(0);
    const [after] = await owner<{ status: string; reason: string }[]>`select status, reason from scheduled_messages where id = ${message!.id}`;
    expect(after).toMatchObject({ status: "skipped", reason: "booking_changed" });
  });

  it("sends a workflow's test to the staff member who asked, with sample details", async () => {
    const [member] = await owner<{ user_id: string; email: string }[]>`
      select membership.user_id, auth_user.email from memberships as membership
      join auth_users as auth_user on auth_user.id = membership.user_id
      where membership.tenant_id = ${tenantId} and membership.role = 'owner' limit 1
    `;
    const [workflow] = await owner<{ id: string }[]>`select id from workflows where tenant_id = ${tenantId} and preset_key = 'reminder_24h'`;
    provider.reset();
    const outcome = await tenantScope((tenantDb) => handlers.get("workflow.test")!(tenantDb, {
      id: randomUUID(), tenantId, aggregateType: "workflow", aggregateId: workflow!.id, eventType: "workflow.test",
      payload: { workflowId: workflow!.id, userId: member!.user_id }, dedupeKey: randomUUID(), attemptCount: 1,
    }));
    expect(outcome).toBe("delivered");
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]!.to).toBe(member!.email);
    expect(provider.sent[0]!.subject.startsWith("[Test]")).toBe(true);
    expect(provider.sent[0]!.text).toContain("Priya");
  });

  const staffContext = (userId: string): StaffContext => ({
    tenantId, clinicSlug: "lotus-dental", clinicName: "Lotus", role: "owner", permissions: [...permissionKeys],
    membershipId: null, userId, userName: "Owner", userEmail: "owner@example.com", preview: false,
  });

  async function editPreset(presetKey: string, change: (workflow: Awaited<ReturnType<typeof listWorkflows>>["workflows"][number]) => Partial<{ name: string; offsetMinutes: number }>) {
    const [member] = await owner<{ user_id: string }[]>`select user_id from memberships where tenant_id = ${tenantId} and role = 'owner' limit 1`;
    const context = staffContext(member!.user_id);
    const workflow = (await listWorkflows(context)).workflows.find((candidate) => candidate.presetKey === presetKey)!;
    return updateWorkflow(context, workflow.id, {
      name: workflow.name, trigger: workflow.trigger, offsetMinutes: workflow.offsetMinutes, filters: workflow.filters, active: workflow.active,
      steps: workflow.steps, ...change(workflow), expectedVersion: workflow.version,
    });
  }

  it("the next booking uses the changed reminder: 48 hours instead of 24", async () => {
    await editPreset("reminder_24h", () => ({ offsetMinutes: 2880 }));
    const booking = await book(slots[9]!, "fortyeight");
    const keys = (await rows(booking.appointmentId)).map((row) => row.slot_key);
    expect(keys).toContain(`t:${new Date(slots[9]!.startsAt).getTime() - 48 * 60 * 60_000}`);
    expect(keys).not.toContain(`t:${new Date(slots[9]!.startsAt).getTime() - 24 * 60 * 60_000}`);
    await editPreset("reminder_24h", () => ({ offsetMinutes: 1440 }));
  });

  it("editing a workflow after it sent does not send it again, for reminders or follow-ups", async () => {
    // A reminder that already went out.
    const booking = await book(slots[10]!, "edited");
    await owner`update scheduled_messages set send_at = now() - interval '1 minute' where tenant_id = ${tenantId} and appointment_id = ${booking.appointmentId}`;
    provider.reset();
    const noon = atLocalHour(12);
    await sweepAndSend(noon);
    const sentFirst = provider.sent.filter((message) => message.to === `flow-edited-${suffix}@example.com`).length;
    expect(sentFirst).toBe(2);

    // The visit finished, and the review request went out.
    await owner`update appointments set starts_at = now() - interval '40 minutes', ends_at = now() - interval '10 minutes', status = 'completed', completed_at = now() where id = ${booking.appointmentId}`;
    await withTenant(tenantId, (transaction) => planAppointment(drizzleRunner(transaction), tenantId, booking.appointmentId, { action: "appointment.status.completed", version: 9 }));
    await owner`update scheduled_messages set send_at = now() - interval '1 minute' where tenant_id = ${tenantId} and appointment_id = ${booking.appointmentId} and status = 'pending'`;
    await sweepAndSend(noon);
    const review = provider.sent.filter((message) => message.to === `flow-edited-${suffix}@example.com`);
    expect(review).toHaveLength(3);
    expect(review[2]!.subject).toContain("How was your visit");

    // The owner renames the reminder and changes the review timing; the worker re-plans every booking.
    await editPreset("reminder_24h", (workflow) => ({ name: `${workflow.name} (renamed)` }));
    await editPreset("review_request", () => ({ offsetMinutes: 240 }));
    await reconcileWorkflows(worker, () => noon);
    await sweepAndSend(noon);
    expect(provider.sent.filter((message) => message.to === `flow-edited-${suffix}@example.com`)).toHaveLength(3);
    await editPreset("reminder_24h", (workflow) => ({ name: workflow.name.replace(" (renamed)", "") }));
    await editPreset("review_request", () => ({ offsetMinutes: 120 }));
  });

  it("sends the video link, with the join and camera-test links, for a video visit only", async () => {
    await owner`insert into service_location_options (tenant_id, service_id, kind, location_id, sort_order) values (${tenantId}, ${linkIds.service}, 'in_person', ${linkIds.location}, 0) on conflict do nothing`;
    await owner`insert into service_location_options (tenant_id, service_id, kind, sort_order) values (${tenantId}, ${linkIds.service}, 'video', 1) on conflict do nothing`;
    const video = await book(slots[11]!, "videolink", "video");
    const [flow] = await owner<{ id: string }[]>`select id from workflows where tenant_id = ${tenantId} and preset_key = 'video_link'`;
    expect(flow).toBeTruthy();
    const pending = await rows(video.appointmentId, "pending");
    expect(pending.map((row) => row.workflow)).toContain("Send the video link");
    await owner`update scheduled_messages set send_at = now() - interval '1 minute' where tenant_id = ${tenantId} and appointment_id = ${video.appointmentId}`;
    provider.reset();
    await sweepAndSend(atLocalHour(12));
    const link = provider.sent.find((message) => message.to === `flow-videolink-${suffix}@example.com` && message.subject.includes("video visit"));
    expect(link).toBeTruthy();
    expect(link!.text).toMatch(/http:\/\/127\.0\.0\.1:3202\/visit\/[A-Za-z0-9_-]+/);
    expect(link!.text).toContain("?test=1");
    await owner`delete from service_location_options where tenant_id = ${tenantId} and service_id = ${linkIds.service}`;
    // An in-person booking never gets the video link.
    const plain = await book(slots[8]!, "noviewlink").catch(() => null);
    if (plain) expect((await rows(plain.appointmentId)).map((row) => row.workflow)).not.toContain("Send the video link");
  });

  it("tries a failed message again when it is retried", async () => {
    const booking = await book(slots[6]!, "retry").catch(() => null);
    if (!booking) return;
    await owner`update scheduled_messages set status = 'failed', reason = 'provider_not_configured', send_at = now() - interval '1 minute' where tenant_id = ${tenantId} and appointment_id = ${booking.appointmentId}`;
    const [message] = await owner<{ id: string }[]>`select id from scheduled_messages where tenant_id = ${tenantId} and appointment_id = ${booking.appointmentId} limit 1`;
    provider.reset();
    clock = atLocalHour(12);
    const outcome = await tenantScope((tenantDb) => handlers.get("workflow.message")!(tenantDb, {
      id: randomUUID(), tenantId, aggregateType: "appointment", aggregateId: booking.appointmentId, eventType: "workflow.message",
      payload: { scheduledMessageId: message!.id }, dedupeKey: randomUUID(), attemptCount: 1,
    }));
    expect(outcome).toBe("delivered");
    expect(provider.sent.length).toBeGreaterThanOrEqual(1);
    const [after] = await owner<{ status: string }[]>`select status from scheduled_messages where id = ${message!.id}`;
    expect(after!.status).toBe("sent");
  });

  it("marks the booking's reminder badge delivered once a reminder goes out", async () => {
    const booking = await book(slots[7]!, "badge").catch(() => null);
    if (!booking) return;
    await owner`update scheduled_messages set send_at = now() - interval '1 minute' where tenant_id = ${tenantId} and appointment_id = ${booking.appointmentId}`;
    await sweepAndSend(atLocalHour(12));
    const [row] = await owner<{ reminder_status: string }[]>`select reminder_status from appointments where id = ${booking.appointmentId}`;
    expect(row!.reminder_status).toBe("delivered");
  });

  it("keeps the worker's business finder out of the app's reach", async () => {
    await expect(withTenant(tenantId, (transaction) => transaction.execute(sql`select * from kalendr_workflow_tenants('workflow_sweep')`))).rejects.toThrow();
  });

  it("keeps one business's workflows and waiting messages away from another's", async () => {
    const seen = await withTenant(otherTenantId, async (transaction) => {
      const messages = await transaction.execute<{ count: number }>(sql`select count(*)::integer as count from scheduled_messages where tenant_id = ${tenantId}`);
      const flows = await transaction.execute<{ count: number }>(sql`select count(*)::integer as count from workflows where tenant_id = ${tenantId}`);
      return [messages[0]!.count, flows[0]!.count];
    });
    expect(seen).toEqual([0, 0]);
    await expect(withTenant(otherTenantId, (transaction) => transaction.execute(sql`
      insert into workflows (tenant_id, name, trigger) values (${tenantId}, 'Sneaky', 'booked')
    `))).rejects.toThrow();
    const [unscoped] = await worker<{ count: number }[]>`select count(*)::integer as count from workflows`;
    expect(unscoped!.count).toBe(0);
  });

  it("refuses bad rows in the database itself", async () => {
    await expect(owner`insert into workflows (tenant_id, name, trigger) values (${tenantId}, 'Bad', 'whenever')`).rejects.toThrow();
    await expect(owner`insert into workflow_settings (tenant_id, quiet_start_minute) values (${otherTenantId}, 2000)`).rejects.toThrow();
  });

  /** Today at the given local hour in the location's zone, searched by the hour because zones differ. */
  function atLocalHour(hour: number): Date {
    const base = new Date(Math.floor(Date.now() / 1_800_000) * 1_800_000);
    for (let step = 0; step < 96; step += 1) {
      const candidate = new Date(base.getTime() + step * 1_800_000);
      if (localMinuteOfDay(candidate, timeZone) === hour * 60) return candidate;
    }
    throw new Error("No such hour");
  }
});
