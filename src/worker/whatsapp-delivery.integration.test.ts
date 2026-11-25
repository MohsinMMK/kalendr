/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withTenant } from "@/db/client";
import { createAppointment, listAvailability } from "@/server/appointment-repository";
import { createCaptureChannel } from "@/server/channels/capture";
import { intakeStatuses } from "@/server/channels/webhook-intake";
import { applyTemplateStatuses, intakeInbound } from "@/server/channels/whatsapp-intake";
import { parseCallback } from "@/server/channels/whatsapp-cloud";
import { ApiError } from "@/server/api-error";
import type { StaffContext } from "@/server/staff-context";
import { assignThread, getThread, listThreads, markThreadRead, sendThreadReply } from "@/server/threads";
import { buttonTapCallback, inboundTextCallback, statusCallback } from "@/test/whatsapp-webhook";

import { providerSink } from "./delivery";
import { createEmailAdapter } from "./email-adapter";
import { createHandlers, type OutboxEvent } from "./handlers";
import type { HandlerOutcome } from "./handlers/types";
import { createSmsAdapter } from "./sms-adapter";
import { createWhatsAppAdapter } from "./whatsapp-adapter";
import { createFakeEmailProvider } from "@/server/messaging/email-fake";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const isLocal = (url: string | undefined) => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && ["5544", "5545", "5561"].includes(parsed.port) && ["/kalendr_local", "/nira_local"].includes(parsed.pathname);
};
const describeLocal = isLocal(runtimeUrl) && isLocal(ownerUrl) && isLocal(workerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

describeLocal("WhatsApp delivery and inbox", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  const suffix = randomUUID().slice(0, 8);
  const phoneDigits = `92${String(Date.now()).slice(-8)}`;
  const phone = `+91${phoneDigits}`;
  const email = `wa-${suffix}@example.com`;
  let tenantId = "";
  let otherTenantId = "";
  let appointmentId = "";
  let patientId = "";
  const whatsapp = createCaptureChannel("whatsapp");
  const sms = createCaptureChannel("sms");
  const emailProvider = createFakeEmailProvider();
  const origin = "http://127.0.0.1:3202";
  const handlers = createHandlers({
    sink: providerSink({
      whatsapp: createWhatsAppAdapter({ channel: whatsapp, origin, allowUnapproved: true }),
      sms: createSmsAdapter({ channel: sms, origin, allowUnapproved: true }),
      email: createEmailAdapter({ provider: emailProvider, origin, fallbackReplyTo: null }),
    }),
    now: () => new Date(),
    channels: { whatsapp },
    origin,
    allowUnapprovedTemplates: true,
  });
  const staff = (): StaffContext => ({
    tenantId, clinicSlug: "lotus-dental", clinicName: "Lotus Dental Studio", role: "receptionist",
    permissions: ["inbox.reply", "settings.manage"], membershipId: null, userId: null, userName: "Front desk", userEmail: "desk@example.com", preview: false,
  });

  async function run(event: OutboxEvent): Promise<HandlerOutcome> {
    return worker.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      return handlers.get(event.eventType)!(tenantDb, event);
    }) as Promise<HandlerOutcome>;
  }

  /** Runs every pending outbox row of these types for the business, like the worker would, then marks them done. */
  async function drain(...types: string[]): Promise<number> {
    const rows = await owner<{ id: string; aggregate_type: string; aggregate_id: string; event_type: string; payload: unknown; dedupe_key: string }[]>`
      select id, aggregate_type, aggregate_id, event_type, payload, dedupe_key from outbox_events
      where tenant_id = ${tenantId} and status = 'pending' and event_type = any(${types}) order by created_at
    `;
    for (const row of rows) {
      const outcome = await run({
        id: row.id, tenantId, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id,
        eventType: row.event_type, payload: row.payload, dedupeKey: row.dedupe_key, attemptCount: 1,
      });
      expect(outcome).toBe("delivered");
      await owner`update outbox_events set status = 'delivered' where id = ${row.id}`;
    }
    return rows.length;
  }

  /** Queues a message event for the booking as the repository would, with a fresh key. */
  async function queueAppointmentEvent(eventType: string, key: string): Promise<void> {
    const [row] = await owner<{ version: number }[]>`select version from appointments where id = ${appointmentId}`;
    await owner`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
      values (${tenantId}, 'appointment', ${appointmentId}, ${eventType},
        ${owner.json({ appointmentId, version: row!.version })}, ${`${eventType}:${appointmentId}:${key}`})
    `;
  }

  async function notifications() {
    return owner<{ id: string; channel: string; status: string; provider_message_id: string | null; read_at: Date | null; cost_category: string | null; failure_code: string | null; template_key: string }[]>`
      select id, channel::text, status::text, provider_message_id, read_at, cost_category, failure_code, template_key from notifications
      where tenant_id = ${tenantId} and appointment_id = ${appointmentId} order by created_at
    `;
  }

  async function appointment() {
    const [row] = await owner<{ confirmation_status: string; version: number }[]>`select confirmation_status::text, version from appointments where id = ${appointmentId}`;
    return row!;
  }

  async function consent() {
    const [row] = await owner<{ messaging_consent_at: Date | null }[]>`select messaging_consent_at from patients where id = ${patientId}`;
    return row!.messaging_consent_at;
  }

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 1, prepare: false, onnotice: () => undefined });
    worker = postgres(workerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    const [tenant] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    const [other] = await owner<{ id: string }[]>`select id from tenants where slug <> 'lotus-dental' order by slug limit 1`;
    tenantId = tenant!.id;
    otherTenantId = other!.id;
    const [link] = await owner<{ location_id: string; service_id: string; practitioner_id: string }[]>`
      select location.location_id, service.service_id, service.practitioner_id
      from practitioner_services as service
      join practitioner_locations as location
        on location.tenant_id = service.tenant_id and location.practitioner_id = service.practitioner_id
      where service.tenant_id = ${tenantId} limit 1
    `;
    const day = 24 * 60 * 60 * 1_000;
    const slots = await listAvailability({
      clinicSlug: "lotus-dental", locationId: link!.location_id, serviceId: link!.service_id, practitionerId: link!.practitioner_id,
      from: new Date(Date.now() + 50 * day).toISOString(), to: new Date(Date.now() + 57 * day).toISOString(),
    });
    const slot = slots.at(-4);
    if (!slot) throw new Error("Expected an open slot");
    const created = await createAppointment({
      clinicSlug: "lotus-dental", patientType: "new", bookingFor: "self", locationId: link!.location_id, serviceId: link!.service_id,
      practitionerId: link!.practitioner_id, slotId: randomUUID(), startsAt: slot.startsAt, endsAt: slot.endsAt,
      firstName: "Asha", lastName: "Rao", phone, email, preferredChannel: "whatsapp", acceptedPrivacyNotice: true, messagingConsent: true,
    }, randomUUID(), randomUUID().replaceAll("-", ""));
    appointmentId = created.appointmentId;
    const [row] = await owner<{ patient_id: string }[]>`select patient_id from appointments where id = ${appointmentId}`;
    patientId = row!.patient_id;
  });

  afterAll(async () => {
    await owner.begin(async (transaction) => {
      await transaction`delete from messages where tenant_id = ${tenantId} and thread_id in (select id from message_threads where patient_id = ${patientId})`;
      await transaction`delete from message_threads where tenant_id = ${tenantId} and patient_id = ${patientId}`;
      await transaction`delete from outbox_events where tenant_id = ${tenantId} and (aggregate_id = ${appointmentId} or event_type like 'thread.%' or event_type like 'channel.%' or event_type like 'notification.%')`;
      await transaction`delete from notifications where tenant_id = ${tenantId} and appointment_id = ${appointmentId}`;
      await transaction`delete from audit_events where tenant_id = ${tenantId} and (appointment_id = ${appointmentId} or action like 'thread.%' or action like 'consent.%')`;
      await transaction`delete from short_links where tenant_id = ${tenantId} and appointment_id = ${appointmentId}`;
      await transaction`delete from appointments where id = ${appointmentId}`;
      await transaction`delete from idempotency_keys where tenant_id = ${tenantId} and created_at > now() - interval '10 minutes'`;
      // STOP writes a consent record; only the table owner with the erase flag may remove one.
      await transaction`select set_config('kalendr.consent_erase', 'on', true)`;
      await transaction`delete from consent_records where tenant_id = ${tenantId} and patient_id = ${patientId}`;
      await transaction`delete from patients where id = ${patientId}`;
    }).catch((error: unknown) => console.error("whatsapp test cleanup failed", error));
    await Promise.all([owner.end(), worker.end()]);
  });

  it("sends the booking confirmation on WhatsApp once, as an approved template, and opens a thread", async () => {
    await drain("appointment.created");
    expect(whatsapp.sent).toHaveLength(1);
    const message = whatsapp.sent[0]!;
    expect(message.to).toBe(phone);
    expect(message.content).toMatchObject({ kind: "template", templateKey: "booking_confirmed", provider: { name: "kalendr_booking_confirmed" } });
    if (message.content.kind !== "template") throw new Error("expected a template");
    expect(message.content.variables[0]).toBe("Asha");
    expect(message.content.variables[4]).toContain(`${origin}/manage/`);
    const [notification] = await notifications();
    expect(notification).toMatchObject({ channel: "whatsapp", status: "sending", cost_category: "utility" });
    const [thread] = await owner<{ id: string }[]>`select id from message_threads where tenant_id = ${tenantId} and patient_id = ${patientId}`;
    expect(thread).toBeDefined();
    expect(emailProvider.sent).toHaveLength(0);
  });

  it("sends a reminder with Confirm and Reschedule buttons", async () => {
    await queueAppointmentEvent("appointment.reminder", "1");
    await drain("appointment.reminder");
    const reminder = whatsapp.sent.at(-1)!;
    if (reminder.content.kind !== "template") throw new Error("expected a template");
    expect(reminder.content.templateKey).toBe("reminder");
    expect(reminder.content.buttons?.map((button) => button.label)).toEqual(["Confirm", "Reschedule"]);
    expect(reminder.content.buttons?.[0]?.payload).toBe(`confirm:${appointmentId}`);
  });

  it("applies delivered then read, never moving a message backwards, and records the billed category", async () => {
    const [confirmation] = await notifications();
    const id = confirmation!.provider_message_id!;
    const post = (body: unknown, eventPrefix: string) => intakeStatuses("whatsapp", parseCallback(JSON.stringify(body)).statuses.map((event) => ({ ...event, eventId: `${eventPrefix}:${event.eventId}` })));
    expect((await post(statusCallback(id, "delivered", "utility"), suffix)).queued).toBe(1);
    // The same callback again queues nothing.
    expect((await post(statusCallback(id, "delivered", "utility"), suffix)).queued).toBe(0);
    expect((await post(statusCallback("not-ours", "delivered"), suffix)).unknown).toBe(1);
    await post(statusCallback(id, "read", "utility"), suffix);
    await post(statusCallback(id, "sent", "utility"), suffix);
    await drain("channel.status");
    const [after] = await notifications();
    expect(after).toMatchObject({ status: "delivered", cost_category: "utility" });
    expect(after!.read_at).not.toBeNull();
    const [message] = await owner<{ status: string }[]>`select status from messages where tenant_id = ${tenantId} and provider_message_id = ${id}`;
    expect(message!.status).toBe("read");
  });

  it("marks the appointment confirmed when the customer taps Confirm, with a version bump and an audit row", async () => {
    const before = await appointment();
    expect(before.confirmation_status).toBe("needs_action");
    const reminderId = (await notifications()).find((notification) => notification.template_key === "appointment.reminder")!.provider_message_id!;
    const tap = parseCallback(JSON.stringify(buttonTapCallback(phone, `wamid.tap-${suffix}`, `confirm:${appointmentId}`, "Confirm", reminderId)));
    expect((await intakeInbound(tap.inbound)).stored).toBe(1);
    // Meta retries: the same tap is ignored.
    expect((await intakeInbound(tap.inbound)).stored).toBe(0);
    await drain("channel.inbound");
    const after = await appointment();
    expect(after.confirmation_status).toBe("confirmed");
    expect(after.version).toBe(before.version + 1);
    const [audit] = await owner<{ count: number }[]>`select count(*)::integer as count from audit_events where tenant_id = ${tenantId} and appointment_id = ${appointmentId} and action = 'appointment.confirm'`;
    expect(audit!.count).toBe(1);
  });

  it("stores a typed reply sealed, raises the unread count and opens the 24-hour window", async () => {
    const text = `Can I come earlier? ${suffix}`;
    const callback = parseCallback(JSON.stringify(inboundTextCallback(phone, `wamid.text-${suffix}`, text)));
    expect((await intakeInbound(callback.inbound)).stored).toBe(1);
    await drain("channel.inbound");
    const [stored] = await owner<{ body_ciphertext: string }[]>`select body_ciphertext from messages where tenant_id = ${tenantId} and provider_message_id = ${`wamid.text-${suffix}`}`;
    expect(stored!.body_ciphertext).not.toContain("earlier");
    const outbox = await owner<{ payload: unknown }[]>`select payload from outbox_events where tenant_id = ${tenantId} and event_type = 'channel.inbound'`;
    expect(JSON.stringify(outbox)).not.toContain("earlier");
    expect(JSON.stringify(outbox)).not.toContain(phoneDigits);

    const list = await listThreads(staff(), "unread");
    const entry = list.find((thread) => thread.patientId === patientId)!;
    expect(entry).toMatchObject({ unreadCount: 2, windowOpen: true, preview: text });
    const detail = await getThread(staff(), entry.id);
    expect(detail.messages.at(-1)).toMatchObject({ direction: "inbound", text });
    expect(detail.nextAppointment?.id).toBe(appointmentId);
    await markThreadRead(staff(), entry.id);
    expect((await listThreads(staff(), "unread")).some((thread) => thread.patientId === patientId)).toBe(false);
    await assignThread(staff(), entry.id, null);
  });

  it("lets staff answer inside the window, once per Idempotency-Key, and sends it from the worker", async () => {
    const [thread] = await owner<{ id: string }[]>`select id from message_threads where tenant_id = ${tenantId} and patient_id = ${patientId}`;
    const key = `reply-${suffix}-1`;
    const first = await sendThreadReply(staff(), thread!.id, { kind: "text", body: "Yes, come at 9." }, key);
    const again = await sendThreadReply(staff(), thread!.id, { kind: "text", body: "Yes, come at 9." }, key);
    expect(again).toEqual(first);
    const before = whatsapp.sent.length;
    await drain("thread.reply");
    expect(whatsapp.sent.length).toBe(before + 1);
    expect(whatsapp.sent.at(-1)).toMatchObject({ to: phone, content: { kind: "text", body: "Yes, come at 9." } });
    const detail = await getThread(staff(), thread!.id);
    expect(detail.messages.at(-1)).toMatchObject({ direction: "outbound", status: "sent" });
  });

  it("refuses a typed reply after the window closes and sends an approved template instead", async () => {
    const [thread] = await owner<{ id: string }[]>`select id from message_threads where tenant_id = ${tenantId} and patient_id = ${patientId}`;
    await owner`update message_threads set window_closes_at = now() - interval '1 hour' where id = ${thread!.id}`;
    await expect(sendThreadReply(staff(), thread!.id, { kind: "text", body: "Hello?" }, `reply-${suffix}-2`))
      .rejects.toMatchObject({ code: "window_closed" } satisfies Partial<ApiError>);
    const detail = await getThread(staff(), thread!.id);
    expect(detail.thread.windowOpen).toBe(false);
    expect(detail.replyTemplates.map((template) => template.key)).toContain("reminder");
    await sendThreadReply(staff(), thread!.id, { kind: "template", templateKey: "reminder", appointmentId }, `reply-${suffix}-3`);
    const before = whatsapp.sent.length;
    await drain("thread.reply");
    expect(whatsapp.sent.length).toBe(before + 1);
    expect(whatsapp.sent.at(-1)!.content).toMatchObject({ kind: "template", templateKey: "reminder" });
  });

  it("queues exactly one SMS when WhatsApp reports a failure, however many times it says so", async () => {
    await queueAppointmentEvent("appointment.reminder", "2");
    await drain("appointment.reminder");
    const failing = (await notifications()).filter((notification) => notification.channel === "whatsapp").at(-1)!;
    const failed = parseCallback(JSON.stringify(statusCallback(failing.provider_message_id!, "failed"))).statuses;
    await intakeStatuses("whatsapp", failed);
    await intakeStatuses("whatsapp", failed.map((event) => ({ ...event, eventId: `${event.eventId}:again` })));
    await drain("channel.status");
    await drain("notification.sms_fallback");
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]).toMatchObject({ to: phone, content: { kind: "template", templateKey: "reminder" } });
    const [row] = await owner<{ count: number }[]>`select count(*)::integer as count from outbox_events where tenant_id = ${tenantId} and event_type = 'notification.sms_fallback' and aggregate_id = ${failing.id}`;
    expect(row!.count).toBe(1);
    expect((await notifications()).find((notification) => notification.id === failing.id)).toMatchObject({ status: "failed", failure_code: "whatsapp_131026" });
    const smsNotification = (await notifications()).filter((notification) => notification.channel === "sms");
    expect(smsNotification).toHaveLength(1);
    const [segments] = await owner<{ segments: number | null }[]>`select segments from notifications where id = ${smsNotification[0]!.id}`;
    expect(segments!.segments).toBeGreaterThan(0);
  });

  it("stops WhatsApp after STOP: consent is cleared, one confirmation goes out, and the next update goes by email", async () => {
    const stop = parseCallback(JSON.stringify(inboundTextCallback(phone, `wamid.stop-${suffix}`, "STOP")));
    expect((await intakeInbound(stop.inbound)).stored).toBe(1);
    await drain("channel.inbound");
    expect(await consent()).toBeNull();
    // The STOP is in the consent ledger too, so a later form can't quietly undo it.
    const ledger = await owner<{ granted: boolean; source: string; actor_type: string }[]>`
      select granted, source, actor_type from consent_records where tenant_id = ${tenantId} and patient_id = ${patientId} and purpose = 'appointment_messages'
      order by created_at, id
    `;
    expect(ledger.at(-1)).toEqual({ granted: false, source: "whatsapp_stop", actor_type: "provider" });
    const [audit] = await owner<{ count: number }[]>`select count(*)::integer as count from audit_events where tenant_id = ${tenantId} and action = 'consent.messaging_withdrawn'`;
    expect(audit!.count).toBe(1);
    const before = whatsapp.sent.length;
    await drain("thread.reply");
    expect(whatsapp.sent.length).toBe(before + 1);
    expect(whatsapp.sent.at(-1)!.content).toMatchObject({ kind: "text" });

    await queueAppointmentEvent("appointment.reminder", "3");
    await drain("appointment.reminder");
    expect(whatsapp.sent.length).toBe(before + 1);
    expect(emailProvider.sent.at(-1)?.to).toBe(email);
    expect((await notifications()).at(-1)).toMatchObject({ channel: "email" });
  });

  it("flags a template Meta rejected, in Settings' data", async () => {
    await applyTemplateStatuses([{ eventId: "t", providerTemplateName: "kalendr_cancelled", language: "en", status: "rejected", reason: "INCORRECT_CATEGORY" }]);
    const [row] = await owner<{ status: string; status_reason: string }[]>`select status, status_reason from message_templates where provider_name = 'kalendr_cancelled' and channel = 'whatsapp'`;
    expect(row).toEqual({ status: "rejected", status_reason: "INCORRECT_CATEGORY" });
    await owner`update message_templates set status = 'pending', status_reason = null where provider_name = 'kalendr_cancelled'`;
  });

  it("keeps threads, messages and channel settings inside their business", async () => {
    const seen = await withTenant(otherTenantId, async (transaction) => {
      const threads = await transaction.execute<{ count: number }>(sql`select count(*)::integer as count from message_threads where tenant_id = ${tenantId}`);
      const messages = await transaction.execute<{ count: number }>(sql`select count(*)::integer as count from messages where tenant_id = ${tenantId}`);
      return [threads[0]!.count, messages[0]!.count];
    });
    expect(seen).toEqual([0, 0]);
    await expect(withTenant(otherTenantId, (transaction) => transaction.execute(sql`
      insert into message_threads (tenant_id, patient_id, channel, contact_hash) values (${tenantId}, ${patientId}, 'whatsapp', ${"0".repeat(64)})
    `))).rejects.toThrow();
    const [unscoped] = await worker<{ count: number }[]>`select count(*)::integer as count from message_threads`;
    expect(unscoped!.count).toBe(0);
    // The business that wrote to this number is the only one a reply can be routed to.
    const callback = parseCallback(JSON.stringify(inboundTextCallback("+919000000001", `wamid.nobody-${suffix}`, "hello")));
    expect((await intakeInbound(callback.inbound)).unknown).toBe(1);
  });
});
