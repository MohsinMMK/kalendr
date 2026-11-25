/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { permissionKeys } from "@/lib/permissions";
import type { WorkflowInput } from "@/lib/workflow-contracts";
import { createAppointment, listAvailability } from "@/server/appointment-repository";
import { createCaptureChannel } from "@/server/channels/capture";
import { createFakeEmailProvider } from "@/server/messaging/email-fake";
import type { StaffContext } from "@/server/staff-context";
import { createWorkflow } from "@/server/workflows/service";

import { providerSink } from "./delivery";
import { createEmailAdapter } from "./email-adapter";
import { createHandlers } from "./handlers";
import { createSmsAdapter } from "./sms-adapter";
import { createWhatsAppAdapter } from "./whatsapp-adapter";
import { sweepTenantMessages } from "./workflow-jobs";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const isLocal = (url: string | undefined) => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && parsed.pathname === "/kalendr_local";
};
const describeLocal = isLocal(runtimeUrl) && isLocal(ownerUrl) && isLocal(workerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

const filters = { serviceIds: [], locationIds: [], practitionerIds: [], bookingSources: [], deliveryModes: [] };
const step = (channel: "email" | "whatsapp" | "sms", templateKey: "reminder" | "booking_confirmed" | null): WorkflowInput["steps"][number] => ({
  channel, subject: channel === "email" ? "Reminder" : "", body: channel === "email" ? "Hi {customer_first_name}" : "", templateKey,
  waitMinutes: 0, ignoreQuietHours: true, skipIfConfirmed: false,
});

describeLocal("workflows on WhatsApp and SMS", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let tenantId = "";
  let userId = "";
  let slots: { startsAt: string; endsAt: string }[] = [];
  let link = { location: "", service: "", practitioner: "" };
  const created: string[] = [];
  const suffix = randomUUID().slice(0, 8);
  const whatsapp = createCaptureChannel("whatsapp");
  const sms = createCaptureChannel("sms");
  const email = createFakeEmailProvider();
  const origin = "http://127.0.0.1:3202";
  const now = new Date();
  const handlers = createHandlers({
    sink: providerSink({
      whatsapp: createWhatsAppAdapter({ channel: whatsapp, origin, allowUnapproved: true }),
      sms: createSmsAdapter({ channel: sms, origin, allowUnapproved: true }),
      email: createEmailAdapter({ provider: email, origin, fallbackReplyTo: null }),
    }),
    now: () => now,
    origin,
    allowUnapprovedTemplates: true,
  });
  const staff = (): StaffContext => ({
    tenantId, clinicSlug: "lotus-dental", clinicName: "Lotus", role: "owner", permissions: [...permissionKeys],
    membershipId: null, userId, userName: "Owner", userEmail: "owner@example.com", preview: false,
  });

  async function book(slot: { startsAt: string; endsAt: string }, label: string, consent: boolean) {
    const result = await createAppointment({
      clinicSlug: "lotus-dental", patientType: "new", bookingFor: "self",
      locationId: link.location, serviceId: link.service, practitionerId: link.practitioner,
      slotId: randomUUID(), startsAt: slot.startsAt, endsAt: slot.endsAt,
      firstName: "Chan", lastName: label, phone: `+91 95${String(Date.now()).slice(-8)}`,
      email: `chan-${label}-${suffix}@example.com`, preferredChannel: "whatsapp",
      acceptedPrivacyNotice: true, messagingConsent: consent,
    }, randomUUID(), randomUUID().replaceAll("-", ""));
    created.push(result.appointmentId);
    return result;
  }

  /** Makes every message for the booking due, hands them to the outbox, and runs them as the worker would. */
  async function sendAll(appointmentId: string): Promise<void> {
    await owner`update scheduled_messages set send_at = now() - interval '1 minute' where tenant_id = ${tenantId} and appointment_id = ${appointmentId}`;
    await worker.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      await sweepTenantMessages(tenantDb, tenantId, new Date());
    });
    const events = await owner<{ id: string; payload: unknown; dedupe_key: string }[]>`
      select id, payload, dedupe_key from outbox_events
      where tenant_id = ${tenantId} and aggregate_id = ${appointmentId} and event_type = 'workflow.message' and status = 'pending'
    `;
    for (const event of events) {
      await worker.begin(async (tenantDb) => {
        await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
        return handlers.get("workflow.message")!(tenantDb, {
          id: event.id, tenantId, aggregateType: "appointment", aggregateId: appointmentId, eventType: "workflow.message",
          payload: event.payload, dedupeKey: event.dedupe_key, attemptCount: 1,
        });
      });
      await owner`update outbox_events set status = 'delivered' where id = ${event.id}`;
    }
  }

  const statuses = (appointmentId: string) => owner<{ channel: string; status: string; reason: string | null }[]>`
    select step.channel, message.status, message.reason from scheduled_messages as message
    join workflow_steps as step on step.tenant_id = message.tenant_id and step.id = message.step_id
    where message.tenant_id = ${tenantId} and message.appointment_id = ${appointmentId} order by step.channel
  `;

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    worker = postgres(workerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    const [tenant] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    tenantId = tenant!.id;
    const [member] = await owner<{ user_id: string }[]>`select user_id from memberships where tenant_id = ${tenantId} and role = 'owner' limit 1`;
    userId = member!.user_id;
    const [row] = await owner<{ location_id: string; service_id: string; practitioner_id: string }[]>`
      select location.location_id, service.service_id, service.practitioner_id
      from practitioner_services as service
      join practitioner_locations as location on location.tenant_id = service.tenant_id and location.practitioner_id = service.practitioner_id
      where service.tenant_id = ${tenantId} limit 1
    `;
    link = { location: row!.location_id, service: row!.service_id, practitioner: row!.practitioner_id };
    await owner`delete from workflows where tenant_id = ${tenantId}`;
    await createWorkflow(staff(), {
      name: "Reminder on every channel", trigger: "before_start", offsetMinutes: 1440, filters, active: true,
      steps: [step("whatsapp", "reminder"), step("sms", "reminder"), step("email", null)],
    });
    const day = 24 * 60 * 60_000;
    const all = await listAvailability({
      clinicSlug: "lotus-dental", locationId: link.location, serviceId: link.service, practitionerId: link.practitioner,
      from: new Date(Date.now() + 4 * day).toISOString(), to: new Date(Date.now() + 12 * day).toISOString(),
    });
    for (const slot of all) {
      const last = slots.at(-1);
      if (!last || new Date(slot.startsAt).getTime() - new Date(last.endsAt).getTime() >= 60 * 60_000) slots.push(slot);
    }
    slots = slots.slice(0, 4);
  });

  afterAll(async () => {
    await owner.begin(async (transaction) => {
      if (created.length > 0) {
        await transaction`delete from outbox_events where tenant_id = ${tenantId} and aggregate_id in ${transaction(created)}`;
        await transaction`delete from notifications where tenant_id = ${tenantId} and appointment_id in ${transaction(created)}`;
        await transaction`delete from audit_events where tenant_id = ${tenantId} and appointment_id in ${transaction(created)}`;
        await transaction`delete from appointments where id in ${transaction(created)}`;
      }
      await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where tenant_id = ${tenantId} and email like ${`chan-%-${suffix}@example.com`})`;
      await transaction`delete from patients where tenant_id = ${tenantId} and email like ${`chan-%-${suffix}@example.com`}`;
      await transaction`delete from workflows where tenant_id = ${tenantId}`;
      await transaction`delete from workflow_settings where tenant_id = ${tenantId}`;
      await transaction`delete from tenant_channel_settings where tenant_id = ${tenantId}`;
      await transaction`delete from idempotency_keys where tenant_id = ${tenantId} and created_at > now() - interval '30 minutes'`;
    }).catch((error: unknown) => console.error("channel test cleanup failed", error));
    await Promise.all([owner.end(), worker.end()]);
  });

  it("sends one workflow on WhatsApp, text and email, each as that channel's own message", async () => {
    const booking = await book(slots[0]!, "all", true);
    expect(await statuses(booking.appointmentId)).toHaveLength(3);
    await sendAll(booking.appointmentId);

    expect(whatsapp.sent).toHaveLength(1);
    const wa = whatsapp.sent[0]!;
    expect(wa.content).toMatchObject({ kind: "template", templateKey: "reminder", language: "en" });
    expect(wa.content.kind === "template" && wa.content.variables[0]).toBe("Chan");
    expect(wa.content.kind === "template" && wa.content.buttons?.map((button) => button.label)).toEqual(["Confirm", "Reschedule"]);

    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]!.content).toMatchObject({ kind: "template", templateKey: "reminder" });
    expect(email.sent.filter((message) => message.to === `chan-all-${suffix}@example.com`)).toHaveLength(1);
    expect((await statuses(booking.appointmentId)).map((row) => row.status)).toEqual(["sent", "sent", "sent"]);

    // Sending again does nothing: each step went once.
    await sendAll(booking.appointmentId);
    expect(whatsapp.attempts).toBe(1);
    expect(sms.attempts).toBe(1);
  });

  it("does not text or WhatsApp a customer who has not agreed to it, but still emails them", async () => {
    whatsapp.reset(); sms.reset(); email.reset();
    const booking = await book(slots[1]!, "noconsent", false);
    await sendAll(booking.appointmentId);
    expect(whatsapp.attempts + sms.attempts).toBe(0);
    expect(email.sent.filter((message) => message.to === `chan-noconsent-${suffix}@example.com`)).toHaveLength(1);
    const rows = await statuses(booking.appointmentId);
    expect(rows.filter((row) => row.channel !== "email")).toEqual([
      { channel: "sms", status: "skipped", reason: "no_consent" },
      { channel: "whatsapp", status: "skipped", reason: "no_consent" },
    ]);
  });

  it("respects a business that switched a channel off", async () => {
    whatsapp.reset(); sms.reset(); email.reset();
    await owner`insert into tenant_channel_settings (tenant_id, whatsapp_enabled, sms_enabled) values (${tenantId}, false, true)
      on conflict (tenant_id) do update set whatsapp_enabled = false, sms_enabled = true`;
    const booking = await book(slots[2]!, "off", true);
    await sendAll(booking.appointmentId);
    expect(whatsapp.attempts).toBe(0);
    expect(sms.sent).toHaveLength(1);
    expect((await statuses(booking.appointmentId)).find((row) => row.channel === "whatsapp")).toMatchObject({ status: "skipped", reason: "channel_off" });
  });

  it("sends a failed provider answer to dead letter-style failure and tries again later", async () => {
    whatsapp.reset(); sms.reset(); email.reset();
    await owner`delete from tenant_channel_settings where tenant_id = ${tenantId}`;
    whatsapp.failNext("rejected");
    const booking = await book(slots[3]!, "fail", true);
    await sendAll(booking.appointmentId);
    expect((await statuses(booking.appointmentId)).find((row) => row.channel === "whatsapp")).toMatchObject({ status: "failed" });
    expect(sms.sent).toHaveLength(1);
    // Staff press "Try again": the same message goes through.
    const [failed] = await owner<{ id: string }[]>`
      select message.id from scheduled_messages as message join workflow_steps as step on step.tenant_id = message.tenant_id and step.id = message.step_id
      where message.tenant_id = ${tenantId} and message.appointment_id = ${booking.appointmentId} and step.channel = 'whatsapp'
    `;
    await worker.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      return handlers.get("workflow.message")!(tenantDb, {
        id: randomUUID(), tenantId, aggregateType: "appointment", aggregateId: booking.appointmentId, eventType: "workflow.message",
        payload: { scheduledMessageId: failed!.id }, dedupeKey: randomUUID(), attemptCount: 2,
      });
    });
    expect(whatsapp.sent).toHaveLength(1);
    expect((await statuses(booking.appointmentId)).find((row) => row.channel === "whatsapp")).toMatchObject({ status: "sent" });
  });
});
