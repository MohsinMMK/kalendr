/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { sql } from "drizzle-orm";

import { requireDatabase, withTenant } from "@/db/client";
import { createAppointment, listAvailability } from "@/server/appointment-repository";
import { createCaptureChannel } from "@/server/channels/capture";
import { hashShortLinkCode, shortLinkCode } from "@/server/channels/short-link-code";
import { rotateManageToken } from "@/server/manage-token";
import { resolveShortLinkToken } from "@/server/short-links";

import { createSmsAdapter } from "./sms-adapter";
import type { ProviderSendRequest } from "./delivery";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const isLocal = (url: string | undefined) => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && ["5544", "5545", "5561"].includes(parsed.port) && ["/kalendr_local", "/nira_local"].includes(parsed.pathname);
};
const describeLocal = isLocal(runtimeUrl) && isLocal(ownerUrl) && isLocal(workerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;
const origin = "http://127.0.0.1:3202";
const currentCode = async (tenantId: string, appointmentId: string, owner: postgres.Sql) => {
  const [row] = await owner<{ manage_token_hash: string }[]>`select manage_token_hash from appointments where tenant_id = ${tenantId} and id = ${appointmentId}`;
  return shortLinkCode(tenantId, appointmentId, row!.manage_token_hash);
};

describeLocal("sms adapter and short links", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let tenantId = "";
  let otherTenantId = "";
  let appointmentId = "";
  let patientId = "";
  let manageToken = "";
  const capture = createCaptureChannel("sms");

  /** Runs the adapter as the worker role, inside the business's scope, as the real worker would. */
  function send(adapter: ReturnType<typeof createSmsAdapter>, templateKey: string, idempotencyKey: string) {
    return worker.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      const request: ProviderSendRequest = {
        tenantDb, tenantId, appointmentId, patientId, channel: "sms", templateKey, body: "", idempotencyKey,
      };
      return adapter.send(request);
    });
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
      from: new Date(Date.now() + 50 * day).toISOString(),
      to: new Date(Date.now() + 57 * day).toISOString(),
    });
    const slot = slots.at(-4);
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
      firstName: "Sms",
      lastName: "Test",
      phone: `+91 93${String(Date.now()).slice(-8)}`,
      email: `sms-${randomUUID().slice(0, 8)}@example.com`,
      preferredChannel: "phone",
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
      await transaction`delete from short_links where tenant_id = ${tenantId} and appointment_id = ${appointmentId}`;
      await transaction`delete from outbox_events where tenant_id = ${tenantId} and aggregate_id = ${appointmentId}`;
      await transaction`delete from notifications where tenant_id = ${tenantId} and appointment_id = ${appointmentId}`;
      await transaction`delete from audit_events where tenant_id = ${tenantId} and appointment_id = ${appointmentId}`;
      await transaction`delete from appointments where id = ${appointmentId}`;
      await transaction`delete from idempotency_keys where tenant_id = ${tenantId} and created_at > now() - interval '10 minutes'`;
      await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where id = ${patientId})`;
      await transaction`delete from patients where id = ${patientId}`;
    }).catch((error: unknown) => {
      console.error("sms test cleanup failed", error);
    });
    await Promise.all([owner.end(), worker.end()]);
  });

  it("skips a template that DLT has not approved, and rejects an event with no SMS", async () => {
    const strict = createSmsAdapter({ channel: capture, origin });
    expect(await send(strict, "appointment.created", "sms:k0")).toEqual({ status: "skipped", code: "template_not_approved" });
    expect(await send(strict, "appointment.something_else", "sms:k0")).toEqual({ status: "rejected", code: "no_sms_template" });
    expect(capture.attempts).toBe(0);
  });

  it("sends variables in the template's order with a short link, once per idempotency key", async () => {
    const adapter = createSmsAdapter({ channel: capture, origin, allowUnapproved: true });
    const first = await send(adapter, "appointment.created", "sms:k1");
    expect(first).toMatchObject({ status: "sent" });
    const [message] = capture.sent;
    expect(message?.to).toMatch(/^\+9193\d{8}$/);
    expect(message?.content).toMatchObject({ kind: "template", templateKey: "booking_confirmed", language: "en" });
    const variables = message?.content.kind === "template" ? message.content.variables : [];
    expect(variables).toHaveLength(4);
    expect(variables[0]).toBe("Sms");
    expect(variables[1]).toBe("Lotus Dental Studio");
    const code = await currentCode(tenantId, appointmentId, owner);
    expect(variables[3]).toBe(`${origin}/m/${code}`);

    // The same message again: the channel drops it, and the link row is reused, not duplicated.
    expect(await send(adapter, "appointment.created", "sms:k1")).toEqual(first);
    expect(capture.sent).toHaveLength(1);
    const [count] = await owner<{ count: number }[]>`select count(*)::integer as count from short_links where tenant_id = ${tenantId} and appointment_id = ${appointmentId}`;
    expect(count!.count).toBe(1);
  });

  it("opens the manage token behind a live code and ignores an expired one", async () => {
    const code = await currentCode(tenantId, appointmentId, owner);
    expect(await resolveShortLinkToken(code)).toBe(manageToken);
    expect(await resolveShortLinkToken("aaaaaaaaaa")).toBeNull();

    await owner`update short_links set expires_at = now() - interval '1 minute' where tenant_id = ${tenantId} and appointment_id = ${appointmentId}`;
    const expired = await requireDatabase().execute(sql`select * from kalendr_resolve_short_link(${hashShortLinkCode(code)})`);
    expect(expired).toHaveLength(0);
    expect(await resolveShortLinkToken(code)).toBeNull();

    // Sending again renews the expiry (a reschedule), and the same code works again.
    const adapter = createSmsAdapter({ channel: capture, origin, allowUnapproved: true });
    await send(adapter, "appointment.reschedule", "sms:k2");
    expect(await resolveShortLinkToken(code)).toBe(manageToken);

    // A reschedule rotates the manage token. The next text carries a new code, and the old one stays dead.
    const rotated = await withTenant(tenantId, (transaction) => rotateManageToken(transaction, tenantId, appointmentId));
    await send(adapter, "appointment.reschedule", "sms:k3");
    const fresh = await currentCode(tenantId, appointmentId, owner);
    expect(fresh).not.toBe(code);
    expect(await resolveShortLinkToken(fresh)).toBe(rotated);
    expect(await resolveShortLinkToken(code)).toBeNull();
  });

  it("keeps a short link inside its business", async () => {
    const seen = await withTenant(otherTenantId, (transaction) => transaction.execute<{ count: number }>(
      sql`select count(*)::integer as count from short_links where tenant_id = ${tenantId}`,
    ));
    expect(seen[0]!.count).toBe(0);
    await expect(withTenant(otherTenantId, (transaction) => transaction.execute(sql`
      insert into short_links (tenant_id, appointment_id, code_hash, expires_at)
      values (${tenantId}, ${appointmentId}, ${"1".repeat(64)}, now() + interval '1 day')
    `))).rejects.toThrow();
  });
});
