/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withTenant } from "@/db/client";
import { sql } from "drizzle-orm";
import { createAppointment, listAvailability } from "@/server/appointment-repository";
import { createFakeEmailProvider } from "@/server/messaging/email-fake";
import { applyResendEvent } from "@/server/messaging/resend-webhook";
import { destinationHash } from "@/server/messaging/suppression";

import { providerSink } from "./delivery";
import { createEmailAdapter } from "./email-adapter";
import { createHandlers, type OutboxEvent } from "./handlers";
import type { HandlerOutcome } from "./handlers/types";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const isLocal = (url: string | undefined) => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && ["5544", "5545"].includes(parsed.port) && ["/kalendr_local", "/nira_local"].includes(parsed.pathname);
};
const describeLocal = isLocal(runtimeUrl) && isLocal(ownerUrl) && isLocal(workerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

describeLocal("email delivery", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  const suffix = randomUUID().slice(0, 8);
  const email = `email-${suffix}@example.com`;
  let manageToken = "";
  let tenantId = "";
  let otherTenantId = "";
  let appointmentId = "";
  let patientId = "";
  const provider = createFakeEmailProvider({ idPrefix: `fake-email-${suffix}` });
  const handlers = createHandlers({
    sink: providerSink({ email: createEmailAdapter({ provider, origin: "http://127.0.0.1:3202", fallbackReplyTo: null }) }),
    now: () => new Date(),
  });

  /** Runs the worker's handler for one outbox row, as the worker role, inside the business's scope. */
  async function runEvent(eventType: string, dedupeSuffix = ""): Promise<HandlerOutcome> {
    return worker.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      const [row] = await tenantDb<{ id: string; aggregate_type: string; aggregate_id: string; event_type: string; payload: unknown; dedupe_key: string }[]>`
        select id, aggregate_type, aggregate_id, event_type, payload, dedupe_key from outbox_events
        where tenant_id = ${tenantId} and aggregate_id = ${appointmentId} and event_type = ${eventType}
        order by created_at limit 1
      `;
      if (!row) throw new Error(`No ${eventType} event`);
      const event: OutboxEvent = {
        id: row.id,
        tenantId,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: row.payload,
        dedupeKey: row.dedupe_key + dedupeSuffix,
        attemptCount: 1,
      };
      return handlers.get(eventType)!(tenantDb, event);
    }) as Promise<HandlerOutcome>;
  }

  async function notifications() {
    return owner<{ status: string; failure_code: string | null; provider_message_id: string | null; semantic_key: string }[]>`
      select status::text, failure_code, provider_message_id, semantic_key from notifications
      where tenant_id = ${tenantId} and appointment_id = ${appointmentId} order by created_at
    `;
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
      clinicSlug: "lotus-dental",
      locationId: link!.location_id,
      serviceId: link!.service_id,
      practitionerId: link!.practitioner_id,
      from: new Date(Date.now() + 40 * day).toISOString(),
      to: new Date(Date.now() + 47 * day).toISOString(),
    });
    const slot = slots.at(-3);
    if (!slot) throw new Error("Expected an open slot");
    const created = await createAppointment({
      clinicSlug: "lotus-dental",
      patientType: "new",
      bookingFor: "self",
      locationId: link!.location_id,
      serviceId: link!.service_id,
      practitionerId: link!.practitioner_id,
      slotId: randomUUID(),
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      firstName: "Email",
      lastName: "Test",
      phone: `+91 92${String(Date.now()).slice(-8)}`,
      email,
      preferredChannel: "email",
      acceptedPrivacyNotice: true,
      messagingConsent: false,
    }, randomUUID(), randomUUID().replaceAll("-", ""));
    appointmentId = created.appointmentId;
    manageToken = created.manageToken;
    const [row] = await owner<{ patient_id: string }[]>`select patient_id from appointments where id = ${appointmentId}`;
    patientId = row!.patient_id;
  });

  afterAll(async () => {
    await owner.begin(async (transaction) => {
      await transaction`delete from message_suppressions where tenant_id = ${tenantId} and destination_hash = ${destinationHash("email", email)}`;
      await transaction`delete from message_delivery_events where tenant_id = ${tenantId} and provider_event_id like ${`evt_${suffix}_%`}`;
      await transaction`delete from outbox_events where tenant_id = ${tenantId} and aggregate_id = ${appointmentId}`;
      await transaction`delete from notifications where tenant_id = ${tenantId} and appointment_id = ${appointmentId}`;
      await transaction`delete from audit_events where tenant_id = ${tenantId} and appointment_id = ${appointmentId}`;
      await transaction`delete from appointments where id = ${appointmentId}`;
      await transaction`delete from idempotency_keys where tenant_id = ${tenantId} and created_at > now() - interval '10 minutes'`;
      await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where id = ${patientId})`;
      await transaction`delete from patients where id = ${patientId}`;
    }).catch((error: unknown) => {
      console.error("email test cleanup failed", error);
    });
    await Promise.all([owner.end(), worker.end()]);
  });

  it("sends the booking email once, with the calendar file and a manage link that opens this booking", async () => {
    expect(await runEvent("appointment.created")).toBe("delivered");
    expect(provider.sent).toHaveLength(1);
    const [sent] = provider.sent;
    expect(sent!.to).toBe(email);
    expect(sent!.fromName).toBe("Lotus Dental Studio");
    expect(sent!.text).toContain(`http://127.0.0.1:3202/manage/${manageToken}`);
    expect(sent!.attachments?.[0]?.content).toContain(`UID:${appointmentId}`);
    const [notification] = await notifications();
    expect(notification).toMatchObject({ status: "sending", provider_message_id: `fake-email-${suffix}-1` });

    // A retry of the same event finds the notification and does not call the provider again.
    expect(await runEvent("appointment.created")).toBe("delivered");
    expect(provider.attempts).toBe(1);
  });

  it("marks the email delivered from a webhook, once", async () => {
    const delivered = { type: "email.delivered", data: { email_id: `fake-email-${suffix}-1`, to: [email] } };
    expect(await applyResendEvent(`evt_${suffix}_1`, delivered)).toBe("applied");
    expect(await applyResendEvent(`evt_${suffix}_1`, delivered)).toBe("duplicate");
    expect((await notifications())[0]!.status).toBe("delivered");
    expect(await applyResendEvent(`evt_${suffix}_x`, { ...delivered, data: { email_id: "not-ours", to: [] } })).toBe("unknown_message");
  });

  it("suppresses a hard-bounced address and skips the next email with the reason", async () => {
    const bounce = { type: "email.bounced", data: { email_id: `fake-email-${suffix}-1`, to: [email], bounce: { type: "Permanent" } } };
    expect(await applyResendEvent(`evt_${suffix}_2`, bounce)).toBe("applied");
    expect((await notifications())[0]).toMatchObject({ status: "failed", failure_code: "bounced" });
    const [suppression] = await owner<{ reason: string }[]>`
      select reason from message_suppressions where tenant_id = ${tenantId} and destination_hash = ${destinationHash("email", email)}
    `;
    expect(suppression?.reason).toBe("bounced");

    expect(await runEvent("appointment.created", ":again")).toBe("delivered");
    expect(provider.attempts).toBe(1);
    const latest = (await notifications()).at(-1);
    expect(latest).toMatchObject({ status: "cancelled", failure_code: "suppressed_bounced", provider_message_id: null });
  });

  it("keeps suppressions and delivery events inside their business", async () => {
    const seen = await withTenant(otherTenantId, async (transaction) => {
      const suppressions = await transaction.execute<{ count: number }>(sql`select count(*)::integer as count from message_suppressions where tenant_id = ${tenantId}`);
      const events = await transaction.execute<{ count: number }>(sql`select count(*)::integer as count from message_delivery_events where tenant_id = ${tenantId}`);
      return [suppressions[0]!.count, events[0]!.count];
    });
    expect(seen).toEqual([0, 0]);
    await expect(withTenant(otherTenantId, (transaction) => transaction.execute(sql`
      insert into message_suppressions (tenant_id, channel, destination_hash, reason)
      values (${tenantId}, 'email', ${"0".repeat(64)}, 'bounced')
    `))).rejects.toThrow();
    // The worker role sees nothing outside a business's scope.
    const [unscoped] = await worker<{ count: number }[]>`select count(*)::integer as count from message_suppressions`;
    expect(unscoped!.count).toBe(0);
  });
});
