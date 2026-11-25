/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createAppointment, listAvailability } from "@/server/appointment-repository";
import { createMsg91Channel } from "@/server/channels/sms-msg91";

import { providerSink } from "./delivery";
import { createHandlers, type OutboxEvent } from "./handlers";
import type { HandlerOutcome } from "./handlers/types";
import { createSmsAdapter } from "./sms-adapter";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const isLocal = (url: string | undefined) => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && ["5544", "5545", "5561"].includes(parsed.port) && ["/kalendr_local", "/nira_local"].includes(parsed.pathname);
};
const describeLocal = isLocal(runtimeUrl) && isLocal(ownerUrl) && isLocal(workerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

/** Feature 4's Done-when, end to end against MSG91's request shape with a fake network. */
describeLocal("SMS delivery (MSG91, DLT)", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let tenantId = "";
  let appointmentId = "";
  let patientId = "";
  const requests: Array<{ url: string; headers: Record<string, string>; body: { template_id: string; recipients: Array<Record<string, string>> } }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return Response.json({ type: "success", message: `req-${requests.length}-${randomUUID().slice(0, 6)}` });
  };
  const channel = createMsg91Channel({ authKey: "test-key", senderId: "KLNDR", fetch: fetchImpl });
  const handlers = (language: string) => createHandlers({
    sink: providerSink({ sms: createSmsAdapter({ channel, origin: "http://127.0.0.1:3202", language, allowUnapproved: false }) }),
    now: () => new Date(),
  });

  async function run(language: string, key: string): Promise<HandlerOutcome> {
    const [row] = await owner<{ version: number }[]>`select version from appointments where id = ${appointmentId}`;
    await owner`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
      values (${tenantId}, 'appointment', ${appointmentId}, 'appointment.created',
        ${owner.json({ appointmentId, version: row!.version })}, ${`sms-test:${appointmentId}:${key}`})
      on conflict (tenant_id, dedupe_key) do nothing
    `;
    const [event] = await owner<{ id: string; payload: unknown; dedupe_key: string }[]>`
      select id, payload, dedupe_key from outbox_events where tenant_id = ${tenantId} and dedupe_key = ${`sms-test:${appointmentId}:${key}`}`;
    const outbox: OutboxEvent = {
      id: event!.id, tenantId, aggregateType: "appointment", aggregateId: appointmentId, eventType: "appointment.created",
      payload: event!.payload, dedupeKey: event!.dedupe_key, attemptCount: 1,
    };
    return worker.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      return handlers(language).get("appointment.created")!(tenantDb, outbox);
    }) as Promise<HandlerOutcome>;
  }

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 1, prepare: false, onnotice: () => undefined });
    worker = postgres(workerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    const [tenant] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    tenantId = tenant!.id;
    const [link] = await owner<{ location_id: string; service_id: string; practitioner_id: string }[]>`
      select location.location_id, service.service_id, service.practitioner_id from practitioner_services as service
      join practitioner_locations as location on location.tenant_id = service.tenant_id and location.practitioner_id = service.practitioner_id
      where service.tenant_id = ${tenantId} limit 1`;
    const day = 24 * 60 * 60 * 1_000;
    const slots = await listAvailability({
      clinicSlug: "lotus-dental", locationId: link!.location_id, serviceId: link!.service_id, practitionerId: link!.practitioner_id,
      from: new Date(Date.now() + 60 * day).toISOString(), to: new Date(Date.now() + 67 * day).toISOString(),
    });
    const slot = slots.at(-5);
    if (!slot) throw new Error("Expected an open slot");
    const created = await createAppointment({
      clinicSlug: "lotus-dental", patientType: "new", bookingFor: "self", locationId: link!.location_id, serviceId: link!.service_id,
      practitionerId: link!.practitioner_id, slotId: randomUUID(), startsAt: slot.startsAt, endsAt: slot.endsAt,
      firstName: "Meera", lastName: "Iyer", phone: `+91 93${String(Date.now()).slice(-8)}`, email: `sms-${randomUUID().slice(0, 8)}@example.com`,
      preferredChannel: "phone", acceptedPrivacyNotice: true, messagingConsent: true,
    }, randomUUID(), randomUUID().replaceAll("-", ""));
    appointmentId = created.appointmentId;
    const [row] = await owner<{ patient_id: string }[]>`select patient_id from appointments where id = ${appointmentId}`;
    patientId = row!.patient_id;
    await owner`update message_templates set provider_template_id = 'DLT-EN-1', status = 'approved' where channel = 'sms' and key = 'booking_confirmed' and language = 'en'`;
    await owner`update message_templates set provider_template_id = 'DLT-HI-1', status = 'approved' where channel = 'sms' and key = 'booking_confirmed' and language = 'hi'`;
  });

  afterAll(async () => {
    await owner.begin(async (transaction) => {
      await transaction`update message_templates set provider_template_id = null, status = 'pending' where channel = 'sms'`;
      await transaction`delete from outbox_events where tenant_id = ${tenantId} and aggregate_id = ${appointmentId}`;
      await transaction`delete from notifications where tenant_id = ${tenantId} and appointment_id = ${appointmentId}`;
      await transaction`delete from audit_events where tenant_id = ${tenantId} and appointment_id = ${appointmentId}`;
      await transaction`delete from short_links where tenant_id = ${tenantId} and appointment_id = ${appointmentId}`;
      await transaction`delete from appointments where id = ${appointmentId}`;
      await transaction`delete from idempotency_keys where tenant_id = ${tenantId} and created_at > now() - interval '10 minutes'`;
      await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where id = ${patientId})`;
      await transaction`delete from patients where id = ${patientId}`;
    }).catch((error: unknown) => console.error("sms test cleanup failed", error));
    await Promise.all([owner.end(), worker.end()]);
  });

  it("sends one SMS with the approved DLT template id and the variables in order, and records its segments", async () => {
    expect(await run("en", "1")).toBe("delivered");
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.headers.authkey).toBe("test-key");
    expect(request.body.template_id).toBe("DLT-EN-1");
    const recipient = request.body.recipients[0]!;
    expect(recipient.VAR1).toBe("Meera");
    expect(recipient.VAR2).toBe("Lotus Dental Studio");
    expect(recipient.VAR4).toMatch(/^http:\/\/127\.0\.0\.1:3202\/m\/[A-Za-z0-9]{10}$/);
    const [notification] = await owner<{ channel: string; status: string; segments: number | null }[]>`
      select channel::text, status::text, segments from notifications where tenant_id = ${tenantId} and appointment_id = ${appointmentId}`;
    expect(notification).toMatchObject({ channel: "sms", status: "sending" });
    expect(notification!.segments).toBeGreaterThanOrEqual(1);
  });

  it("never sends the same event twice", async () => {
    await run("en", "1");
    expect(requests).toHaveLength(1);
  });

  it("counts a Hindi template as Unicode segments, which cost more than the English wording", async () => {
    await run("hi", "2");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.body.template_id).toBe("DLT-HI-1");
    const rows = await owner<{ segments: number }[]>`
      select segments from notifications where tenant_id = ${tenantId} and appointment_id = ${appointmentId} order by created_at`;
    expect(rows).toHaveLength(2);
    // Hindi is 70 characters per segment (67 when longer), so the same booking takes more of them.
    expect(rows[1]!.segments).toBeGreaterThan(rows[0]!.segments);
  });
});
