/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resolvePermissions } from "@/lib/permissions";
import { isolatedDatabaseReady } from "@/test/isolated-database";
import type { StaffContext } from "@/server/staff-context";

vi.mock("server-only", () => ({}));

import { createAppointment, listAvailability } from "@/server/appointment-repository";
import {
  createEndpoint, deleteEndpoint, listDeliveries, listEndpoints, resendDelivery, rotateSecret, sendTestEvent, updateEndpoint,
} from "@/server/webhooks/admin";
import { openSecret } from "@/server/keys/secrets";
import { loadDataKeys } from "@/server/keys/ring";
import { postgresDataKeyStore } from "@/server/keys/postgres-store";
import { verifyWebhookSignature } from "@/server/webhooks/signature";
import { createHttpsTransport, type WebhookRequest, type WebhookTransport, type WebhookTransportResult } from "@/server/webhooks/transport";
import { webhookEnvelopeSchema } from "@/server/webhooks/payloads";

import { localCaptureSink } from "./delivery";
import { createHandlers, type HandlerRegistry } from "./handlers";
import { claimOutboxBatch, processClaimedEvent, releaseClaims } from "./outbox-worker";
import { fanOutWebhooks } from "./webhooks/fanout";
import { defaultWebhookPolicy, type WebhookPolicy } from "./webhooks/policy";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeLocal = isolatedDatabaseReady(runtimeUrl, ownerUrl, workerUrl) ? describe : describe.skip;

const OURS = ["webhook.deliver", "webhook.endpoint.disabled", "appointment.created", "appointment.cancel", "appointment.status.cancelled", "appointment.confirm", "customer.created", "payment.captured"];
const FIXED_CODES = ["timeout", "connection_failed", "blocked_address", "redirect_blocked", "http_status", "tls_error", "endpoint_disabled", "secret_unreadable"];

/** Records every request and answers from a queue, then with 200. Never touches the network. */
class FakeTransport implements WebhookTransport {
  readonly requests: WebhookRequest[] = [];
  /** Scripted answers per address; an address with none left gets the fallback. */
  readonly script = new Map<string, (WebhookTransportResult | "throw")[]>();
  fallback: WebhookTransportResult = { kind: "response", statusCode: 200 };
  async send(request: WebhookRequest): Promise<WebhookTransportResult> {
    this.requests.push(request);
    const next = this.script.get(request.url)?.shift();
    if (next === "throw") throw new Error("socket exploded");
    return next ?? this.fallback;
  }
  to(url: string): WebhookRequest[] { return this.requests.filter((request) => request.url === url); }
}

describeLocal("outgoing webhooks", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  const suffix = randomUUID().slice(0, 8);
  const startedAt = new Date(Date.now() - 1000);
  let tenantA = "";
  let tenantB = "";
  let appointmentId = "";
  let patientId = "";
  let ctxA: StaffContext;
  let ctxB: StaffContext;
  const transport = new FakeTransport();
  const clock = () => new Date();
  const policy: WebhookPolicy = { retryDelaysMs: [0, 0, 0], disableAfterFailures: 50, timeoutMs: 1000 };
  const handlers = (deps: { transport: WebhookTransport; policy?: WebhookPolicy; now?: () => Date }): HandlerRegistry =>
    createHandlers({ sink: localCaptureSink, now: deps.now ?? (() => clock()), webhooks: { transport: deps.transport, policy: deps.policy ?? policy } });
  const url = (label: string) => `https://hooks.example.com/${suffix}/${label}`;
  const secrets = new Map<string, string>();
  const ids = new Map<string, string>();
  const allSecrets = () => [...secrets.values()];

  const context = (tenantId: string): StaffContext => ({
    tenantId, clinicSlug: "x", clinicName: "X", role: "owner", permissions: resolvePermissions("owner", {}),
    membershipId: null, userId: null, userName: "Owner", userEmail: "owner@example.com", preview: false,
  });

  async function add(label: string, ctx: StaffContext, events: Parameters<typeof createEndpoint>[1]["events"]) {
    const created = await createEndpoint(ctx, { url: url(label), description: null, events });
    secrets.set(label, created.secret);
    ids.set(label, created.endpoint.id);
    return created;
  }

  /** Runs every due row of ours (for the two test businesses) until nothing is left. Other rows go back untouched. */
  async function drain(registry: HandlerRegistry, rounds = 12): Promise<number> {
    let processed = 0;
    for (let round = 0; round < rounds; round += 1) {
      const claims = await claimOutboxBatch(worker, `webhook-test-${suffix}`, 200);
      const types = claims.length === 0 ? [] : await owner<{ id: string; event_type: string }[]>`select id, event_type from outbox_events where id in ${owner(claims.map((claim) => claim.id))}`;
      const ours = new Set(types.filter((row) => OURS.includes(row.event_type)).map((row) => row.id));
      const mine = claims.filter((claim) => ours.has(claim.id) && [tenantA, tenantB].includes(claim.tenantId));
      await releaseClaims(worker, claims.filter((claim) => !mine.includes(claim)));
      if (mine.length === 0) return processed;
      for (const claim of mine) {
        await processClaimedEvent(worker, claim, { handlers: registry });
        processed += 1;
      }
    }
    return processed;
  }

  const deliveriesFor = (label: string) => owner<Record<string, unknown>[]>`
    select * from webhook_deliveries where endpoint_id = ${ids.get(label)!} order by created_at, id`;

  async function queueEvent(tenantId: string, type: string, aggregateId: string, payload: object, key: string) {
    await owner`insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
      values (${tenantId}, ${type.startsWith("appointment") ? "appointment" : type.split(".")[0]!}, ${aggregateId}, ${type}, ${owner.json(payload as postgres.JSONValue)}, ${`wh-test:${suffix}:${key}`})`;
  }

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    worker = postgres(workerUrl!, { max: 4, prepare: false, onnotice: () => undefined });
    const [a] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    const [b] = await owner<{ id: string }[]>`select id from tenants where slug = 'riverbend-care'`;
    tenantA = a!.id;
    tenantB = b!.id;
    ctxA = context(tenantA);
    ctxB = context(tenantB);
    const [link] = await owner<{ location_id: string; service_id: string; practitioner_id: string }[]>`
      select location.location_id, service.service_id, service.practitioner_id
      from practitioner_services as service
      join practitioner_locations as location on location.tenant_id = service.tenant_id and location.practitioner_id = service.practitioner_id
      where service.tenant_id = ${tenantA} limit 1`;
    const day = 24 * 60 * 60 * 1_000;
    const slots = await listAvailability({
      clinicSlug: "lotus-dental", locationId: link!.location_id, serviceId: link!.service_id, practitionerId: link!.practitioner_id,
      from: new Date(Date.now() + 40 * day).toISOString(), to: new Date(Date.now() + 47 * day).toISOString(),
    });
    const slot = slots.at(-3);
    if (!slot) throw new Error("Expected an open slot");
    // The endpoints must exist before the booking so its fan-out finds them.
    await add("main", ctxA, ["appointment.created", "appointment.cancelled", "customer.created"]);
    await add("other", ctxA, ["payment.captured"]);
    await add("off", ctxA, ["appointment.created"]);
    await updateEndpoint(ctxA, ids.get("off")!, { status: "disabled", expectedVersion: 1 });
    await add("b", ctxB, ["appointment.created", "appointment.cancelled"]);
    const created = await createAppointment({
      clinicSlug: "lotus-dental", patientType: "new", bookingFor: "self", locationId: link!.location_id, serviceId: link!.service_id,
      practitionerId: link!.practitioner_id, slotId: randomUUID(), startsAt: slot.startsAt, endsAt: slot.endsAt,
      firstName: "Hook", lastName: "Test", phone: `+91 92${String(Date.now()).slice(-8)}`, email: `hook-${suffix}@example.com`,
      preferredChannel: "email", acceptedPrivacyNotice: true, messagingConsent: false,
    }, randomUUID(), randomUUID().replaceAll("-", ""));
    appointmentId = created.appointmentId;
    const [row] = await owner<{ patient_id: string }[]>`select patient_id from appointments where id = ${appointmentId}`;
    patientId = row!.patient_id;
  });

  afterAll(async () => {
    await owner.begin(async (transaction) => {
      await transaction`delete from webhook_endpoints where tenant_id in (${tenantA}, ${tenantB}) and url like ${`https://hooks.example.com/${suffix}/%`}`;
      await transaction`delete from outbox_events where tenant_id in (${tenantA}, ${tenantB}) and (aggregate_id = ${appointmentId} or dedupe_key like ${`wh-test:${suffix}:%`} or created_at > ${startedAt} and event_type like 'webhook.%')`;
      await transaction`delete from notifications where tenant_id = ${tenantA} and (appointment_id = ${appointmentId} or template_key = 'webhook.disabled')`;
      await transaction`delete from audit_events where tenant_id in (${tenantA}, ${tenantB}) and (appointment_id = ${appointmentId} or action like 'webhook.%') and occurred_at > ${startedAt}`;
      await transaction`delete from appointments where id = ${appointmentId}`;
      await transaction`delete from idempotency_keys where tenant_id = ${tenantA} and created_at > ${startedAt}`;
      await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where id = ${patientId})`;
      await transaction`delete from patients where id = ${patientId}`;
    }).catch((error: unknown) => console.error("webhook test cleanup failed", error));
    await Promise.all([owner.end(), worker.end()]);
  });

  it("signs a delivery for a new booking that verifies with the secret returned at creation, and sends no names", async () => {
    expect(await drain(handlers({ transport }))).toBeGreaterThan(0);
    const sent = transport.to(url("main"));
    expect(sent).toHaveLength(1);
    const request = sent[0]!;
    expect(verifyWebhookSignature(secrets.get("main")!, request.headers["X-Kalendr-Signature"]!, request.body)).toEqual({ valid: true });
    expect(verifyWebhookSignature(secrets.get("other")!, request.headers["X-Kalendr-Signature"]!, request.body)).toMatchObject({ valid: false });
    expect(request.headers["X-Kalendr-Event"]).toBe("appointment.created");
    expect(request.headers["User-Agent"]).toBe("Kalendr-Webhooks/1");
    expect(request.headers["Content-Type"]).toBe("application/json");
    const body = webhookEnvelopeSchema.parse(JSON.parse(request.body));
    expect(request.headers["X-Kalendr-Event-Id"]).toBe(body.id);
    expect(body).toMatchObject({ type: "appointment.created", apiVersion: "v1", data: { appointmentId, customerId: patientId, version: 1 } });
    expect(Object.keys(body.data).sort()).toEqual(["appointmentId", "customerId", "endsAt", "locationId", "serviceId", "staffId", "startsAt", "status", "version"]);
    expect(request.body).not.toMatch(/Hook|Test|@example|\+91/);
    const [row] = await deliveriesFor("main");
    expect(row).toMatchObject({ status: "succeeded", attempt: 1, status_code: 200, error_code: null, event_type: "appointment.created" });
    expect(Number(row!.duration_ms)).toBeGreaterThanOrEqual(0);
  });

  it("fans out only to active endpoints subscribed to the event, and never across businesses", async () => {
    expect(transport.to(url("other"))).toHaveLength(0);
    expect(transport.to(url("off"))).toHaveLength(0);
    expect(transport.to(url("b"))).toHaveLength(0);
    expect(await deliveriesFor("off")).toHaveLength(0);
    // Business B's own event reaches only B.
    const [slot] = await owner<{ id: string }[]>`select id from services where tenant_id = ${tenantB} limit 1`;
    expect(slot).toBeDefined();
    await queueEvent(tenantB, "customer.created", randomUUID(), { customerId: "x" }, "b-customer");
    await drain(handlers({ transport }));
    expect(transport.to(url("main"))).toHaveLength(1);
    expect(transport.to(url("b"))).toHaveLength(0);
  });

  it("sends one cancelled event even when both cancel events are queued, and nothing for a confirmation", async () => {
    await queueEvent(tenantA, "appointment.cancel", appointmentId, { appointmentId, version: 9 }, "cancel-1");
    await queueEvent(tenantA, "appointment.status.cancelled", appointmentId, { appointmentId, version: 9 }, "cancel-2");
    await queueEvent(tenantA, "appointment.confirm", appointmentId, { appointmentId, version: 9 }, "confirm");
    await drain(handlers({ transport }));
    const types = (await deliveriesFor("main")).map((row) => row.event_type);
    expect(types.filter((type) => type === "appointment.cancelled")).toHaveLength(1);
    expect(types).toEqual(["appointment.created", "appointment.cancelled"]);
    expect(transport.to(url("b")).map((request) => request.headers["X-Kalendr-Event"])).toEqual([]);
  });

  it("fans out customer and payment events with ids and amounts only, and is safe to run twice", async () => {
    const customerId = randomUUID();
    await queueEvent(tenantA, "customer.created", customerId, { customerId }, "cust");
    await queueEvent(tenantA, "payment.captured", "pay-1", { paymentId: "pay-1", appointmentId, amountMinor: 49900, currency: "INR" }, "pay");
    await drain(handlers({ transport }));
    const payment = transport.to(url("other")).map((request) => JSON.parse(request.body) as { type: string; data: unknown });
    expect(payment).toHaveLength(1);
    expect(payment[0]).toMatchObject({ type: "payment.captured", data: { paymentId: "pay-1", appointmentId, amountMinor: 49900, currency: "INR" } });
    const customer = transport.to(url("main")).filter((request) => request.headers["X-Kalendr-Event"] === "customer.created");
    expect(JSON.parse(customer.at(-1)!.body)).toMatchObject({ data: { customerId } });

    const before = (await deliveriesFor("other")).length;
    await worker.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantA}, true)`;
      const event = { id: "x", tenantId: tenantA, aggregateType: "payment", aggregateId: "pay-1", eventType: "payment.captured", dedupeKey: "k", attemptCount: 1, payload: { paymentId: "pay-1", appointmentId, amountMinor: 49900, currency: "INR" } };
      await fanOutWebhooks(tenantDb, event, new Date());
      await fanOutWebhooks(tenantDb, event, new Date());
    });
    expect(await deliveriesFor("other")).toHaveLength(before);
    const queued = await owner`select 1 from outbox_events where tenant_id = ${tenantA} and event_type = 'webhook.deliver' and aggregate_id in (select id from webhook_deliveries where endpoint_id = ${ids.get("other")!})`;
    expect(queued).toHaveLength(before);
  });

  it("keeps each business's endpoints and deliveries to itself", async () => {
    const seenByB = await worker.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantB}, true)`;
      return {
        endpoints: await tenantDb<{ id: string }[]>`select id from webhook_endpoints`,
        deliveries: await tenantDb<{ id: string }[]>`select id from webhook_deliveries where endpoint_id = ${ids.get("main")!}`,
      };
    });
    expect(seenByB.endpoints.map((row) => row.id)).not.toContain(ids.get("main"));
    expect(seenByB.deliveries).toHaveLength(0);
    expect((await listEndpoints(ctxB)).map((endpoint) => endpoint.id)).not.toContain(ids.get("main"));
    await expect(deleteEndpoint(ctxB, ids.get("main")!)).rejects.toMatchObject({ status: 404 });
    await expect(rotateSecret(ctxB, ids.get("main")!)).rejects.toMatchObject({ status: 404 });
    await expect(sendTestEvent(ctxB, ids.get("main")!)).rejects.toMatchObject({ status: 404 });
    await expect(updateEndpoint(ctxB, ids.get("main")!, { description: "x", expectedVersion: 1 })).rejects.toMatchObject({ status: 404 });
    expect((await listDeliveries(ctxB, { endpointId: ids.get("main")!, limit: 10 })).deliveries).toEqual([]);
    const mainDelivery = (await deliveriesFor("main"))[0]!;
    await expect(resendDelivery(ctxB, mainDelivery.id as string)).rejects.toMatchObject({ status: 404 });
  });

  it("refuses private and unsafe addresses when one is saved, and says so in plain words", async () => {
    for (const bad of ["http://127.0.0.1/hook", "https://127.0.0.1/hook", "https://10.1.2.3/x", "https://[::1]/x", "https://[::ffff:127.0.0.1]/x", "https://localhost/x", "https://169.254.169.254/latest", "http://example.com/x", "https://u:p@example.com/x", "https://example.com:8080/x"]) {
      await expect(createEndpoint(ctxA, { url: bad, description: null, events: ["appointment.created"] }), bad).rejects.toMatchObject({ status: 400, code: "invalid_url" });
    }
    await expect(updateEndpoint(ctxA, ids.get("other")!, { url: "https://192.168.0.9/x", expectedVersion: 1 })).rejects.toMatchObject({ code: "invalid_url" });
    await expect(createEndpoint({ ...ctxA, preview: true }, { url: url("p"), description: null, events: ["appointment.created"] })).rejects.toMatchObject({ code: "preview_only" });
  });

  it("checks versions, edits, and limits a business to ten addresses", async () => {
    const created = await add("edit", ctxA, ["customer.created"]);
    await expect(updateEndpoint(ctxA, created.endpoint.id, { description: "x", expectedVersion: 99 })).rejects.toMatchObject({ status: 409, code: "version_conflict" });
    const updated = await updateEndpoint(ctxA, created.endpoint.id, { description: "CRM", events: ["customer.created", "payment.captured"], expectedVersion: 1 });
    expect(updated).toMatchObject({ description: "CRM", version: 2, events: ["customer.created", "payment.captured"] });
    const disabled = await updateEndpoint(ctxA, created.endpoint.id, { status: "disabled", expectedVersion: 2 });
    expect(disabled).toMatchObject({ status: "disabled", disabledReason: "owner" });
    const reenabled = await updateEndpoint(ctxA, created.endpoint.id, { status: "active", expectedVersion: 3 });
    expect(reenabled).toMatchObject({ status: "active", disabledReason: null, consecutiveFailures: 0 });
    await expect(sendTestEvent(ctxA, ids.get("off")!)).rejects.toMatchObject({ status: 409, code: "endpoint_disabled" });

    const count = (await listEndpoints(ctxB)).length;
    for (let index = count; index < 10; index += 1) await add(`fill${index}`, ctxB, ["customer.created"]);
    await expect(add("eleventh", ctxB, ["customer.created"])).rejects.toMatchObject({ status: 409, code: "webhook_limit" });
    await deleteEndpoint(ctxB, ids.get("fill9") ?? ids.get(`fill${count}`)!);
    await add("replacement", ctxB, ["customer.created"]);
    expect((await listEndpoints(ctxB)).length).toBe(10);
  });

  it("sends a test event and a resend with the same event id, and a test never counts as a failure", async () => {
    const { deliveryId } = await sendTestEvent(ctxA, ids.get("main")!);
    transport.script.set(url("main"), [{ kind: "response", statusCode: 500 }]);
    await drain(handlers({ transport }));
    const [test] = await owner<Record<string, unknown>[]>`select * from webhook_deliveries where id = ${deliveryId}`;
    expect(test).toMatchObject({ is_test: true, event_type: "webhook.test", status: "gave_up", attempt: 1, status_code: 500, error_code: "http_status" });
    const [endpoint] = await owner<{ consecutive_failures: number }[]>`select consecutive_failures from webhook_endpoints where id = ${ids.get("main")!}`;
    expect(endpoint!.consecutive_failures).toBe(0);
    const testRequest = transport.to(url("main")).at(-1)!;
    expect(JSON.parse(testRequest.body)).toMatchObject({ type: "webhook.test", data: { message: "This is a test event from Kalendr." } });

    const original = (await deliveriesFor("main")).find((row) => row.event_type === "appointment.created")!;
    const resent = await resendDelivery(ctxA, original.id as string);
    await drain(handlers({ transport }));
    const [again] = await owner<Record<string, unknown>[]>`select * from webhook_deliveries where id = ${resent.deliveryId}`;
    expect(again).toMatchObject({ resend_of_id: original.id, event_id: original.event_id, status: "succeeded", attempt: 1 });
    expect(transport.to(url("main")).at(-1)!.headers["X-Kalendr-Event-Id"]).toBe(original.event_id);
    expect(transport.to(url("main")).at(-1)!.body).toBe(JSON.stringify(original.payload));
  });

  it("records a redirect as a failure and never follows it, and records a thrown error instead of losing the log", async () => {
    const created = await add("redirect", ctxA, ["payment.captured"]);
    transport.script.set(url("redirect"), [{ kind: "response", statusCode: 302 }, "throw", { kind: "error", errorCode: "timeout" }, { kind: "error", errorCode: "tls_error" }]);
    await queueEvent(tenantA, "payment.captured", "pay-r", { paymentId: "pay-r", appointmentId: null, amountMinor: 100, currency: "INR" }, "pay-r");
    await drain(handlers({ transport }));
    const calls = transport.to(url("redirect"));
    expect(calls).toHaveLength(4);
    const [row] = await deliveriesFor("redirect");
    expect(row).toMatchObject({ attempt: 4, status: "gave_up", error_code: "tls_error" });
    expect(created.endpoint.id).toBe(ids.get("redirect"));
    // Each attempt left a mark: the first was a 302 that was refused.
    const [endpoint] = await owner<{ consecutive_failures: number }[]>`select consecutive_failures from webhook_endpoints where id = ${created.endpoint.id}`;
    expect(endpoint!.consecutive_failures).toBe(4);
  });

  it("refuses a name that resolves to a private address through the real guard, with a fake resolver", async () => {
    await add("rebind", ctxA, ["payment.captured"]);
    const resolver = async () => [{ address: "169.254.169.254", family: 4 as const }];
    await queueEvent(tenantA, "payment.captured", "pay-x", { paymentId: "pay-x", appointmentId: null, amountMinor: 1, currency: "INR" }, "pay-x");
    await drain(handlers({ transport: createHttpsTransport(resolver), policy: { ...policy, retryDelaysMs: [] } }));
    const [row] = await deliveriesFor("rebind");
    expect(row).toMatchObject({ status: "gave_up", attempt: 1, error_code: "blocked_address", status_code: null });
  });

  it("retries on the documented schedule, gives up after eight attempts, then disables the address and queues the owner email", async () => {
    await add("flaky", ctxA, ["payment.captured"]);
    const fixed = new Date("2030-01-01T00:00:00Z");
    const failing = new FakeTransport();
    failing.fallback = { kind: "response", statusCode: 503 };
    const registry = handlers({ transport: failing, policy: defaultWebhookPolicy, now: () => fixed });
    await queueEvent(tenantA, "payment.captured", "pay-f", { paymentId: "pay-f", appointmentId: null, amountMinor: 5, currency: "INR" }, "pay-f");
    const gaps: number[] = [];
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await drain(registry, 3);
      const [row] = await deliveriesFor("flaky");
      expect(row).toMatchObject({ attempt, status_code: 503, error_code: "http_status" });
      if (attempt < 8) {
        expect(row!.status).toBe("retrying");
        gaps.push((new Date(row!.next_attempt_at as Date).getTime() - fixed.getTime()) / 60_000);
        await owner`update outbox_events set available_at = timestamptz '2000-01-01' where tenant_id = ${tenantA} and dedupe_key = ${`webhook.deliver:${row!.id as string}:${attempt + 1}`}`;
      } else {
        expect(row!.status).toBe("gave_up");
        expect(row!.next_attempt_at).toBeNull();
      }
    }
    expect(gaps).toEqual([1, 5, 20, 60, 180, 360, 720]);
    const [afterEight] = await owner<{ consecutive_failures: number; status: string }[]>`select consecutive_failures, status from webhook_endpoints where id = ${ids.get("flaky")!}`;
    expect(afterEight).toEqual({ consecutive_failures: 8, status: "active" });

    // Four more failed attempts in a row reach twelve: the address is switched off.
    const resent = await resendDelivery(ctxA, ((await deliveriesFor("flaky"))[0]!).id as string);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await drain(registry, 3);
      await owner`update outbox_events set available_at = timestamptz '2000-01-01' where tenant_id = ${tenantA} and dedupe_key = ${`webhook.deliver:${resent.deliveryId}:${attempt + 1}`}`;
    }
    const [endpoint] = await owner<{ status: string; disabled_reason: string; disabled_at: Date | null; consecutive_failures: number }[]>`select status, disabled_reason, disabled_at, consecutive_failures from webhook_endpoints where id = ${ids.get("flaky")!}`;
    expect(endpoint).toMatchObject({ status: "disabled", disabled_reason: "repeated_failure", consecutive_failures: 12 });
    expect(endpoint!.disabled_at).not.toBeNull();
    const [resentRow] = await owner<{ status: string }[]>`select status from webhook_deliveries where id = ${resent.deliveryId}`;
    expect(resentRow!.status).toBe("gave_up");

    const disabledRows = await owner<{ status: string; payload: Record<string, unknown> }[]>`select status, payload from outbox_events where tenant_id = ${tenantA} and event_type = 'webhook.endpoint.disabled' and aggregate_id = ${ids.get("flaky")!}`;
    expect(disabledRows).toHaveLength(1);
    expect(disabledRows[0]!.payload).toEqual({ endpointId: ids.get("flaky") });
    await owner`update outbox_events set available_at = timestamptz '2000-01-01' where tenant_id = ${tenantA} and event_type = 'webhook.endpoint.disabled'`;
    await drain(registry, 3);
    const [after] = await owner<{ status: string }[]>`select status from outbox_events where tenant_id = ${tenantA} and event_type = 'webhook.endpoint.disabled' and aggregate_id = ${ids.get("flaky")!}`;
    expect(after!.status).toBe("delivered");
    const email = await owner<{ template_key: string; channel: string }[]>`select template_key, channel from notifications where tenant_id = ${tenantA} and template_key = 'webhook.disabled'`;
    expect(email).toEqual([{ template_key: "webhook.disabled", channel: "email" }]);
    // An event that arrives for the switched-off address is not sent and is logged as such.
    await queueEvent(tenantA, "payment.captured", "pay-g", { paymentId: "pay-g", appointmentId: null, amountMinor: 5, currency: "INR" }, "pay-g");
    await drain(registry, 3);
    expect(await deliveriesFor("flaky")).toHaveLength(2);
  });

  it("gives up on a queued delivery whose address has been switched off, without calling out", async () => {
    const eventId = `evt_off_${suffix}`;
    const [row] = await owner<{ id: string }[]>`insert into webhook_deliveries (tenant_id, endpoint_id, event_id, event_type, payload)
      values (${tenantA}, ${ids.get("off")!}, ${eventId}, 'customer.created', ${owner.json({ id: eventId, type: "customer.created", apiVersion: "v1", createdAt: new Date().toISOString(), data: { customerId: "c" } })}) returning id`;
    await owner`insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
      values (${tenantA}, 'webhook_delivery', ${row!.id}, 'webhook.deliver', ${owner.json({ deliveryId: row!.id })}, ${`webhook.deliver:${row!.id}:1`})`;
    const before = transport.requests.length;
    await drain(handlers({ transport }));
    expect(transport.requests.length).toBe(before);
    expect((await deliveriesFor("off"))[0]).toMatchObject({ status: "gave_up", error_code: "endpoint_disabled" });
  });

  it("pages the delivery log newest first without repeats", async () => {
    const all = await owner<{ id: string }[]>`select id from webhook_deliveries where endpoint_id = ${ids.get("main")!} order by created_at desc, id desc`;
    expect(all.length).toBeGreaterThanOrEqual(4);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await listDeliveries(ctxA, { endpointId: ids.get("main")!, cursor, limit: 2 });
      seen.push(...result.deliveries.map((delivery) => delivery.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen).toEqual(all.map((row) => row.id));
    const endpoints = await listEndpoints(ctxA);
    expect(endpoints.find((endpoint) => endpoint.id === ids.get("main"))?.lastDelivery).toMatchObject({ status: expect.any(String) });
  });

  it("rotates the secret: the old one stops verifying and the new one verifies", async () => {
    const rotated = await rotateSecret(ctxA, ids.get("main")!);
    const oldSecret = secrets.get("main")!;
    secrets.set("main-rotated", rotated.secret);
    expect(rotated.secret).not.toBe(oldSecret);
    expect(rotated.endpoint.version).toBeGreaterThan(1);
    const before = transport.to(url("main")).length;
    await sendTestEvent(ctxA, ids.get("main")!);
    await drain(handlers({ transport }));
    const request = transport.to(url("main")).at(-1)!;
    expect(transport.to(url("main")).length).toBe(before + 1);
    expect(verifyWebhookSignature(rotated.secret, request.headers["X-Kalendr-Signature"]!, request.body)).toEqual({ valid: true });
    expect(verifyWebhookSignature(oldSecret, request.headers["X-Kalendr-Signature"]!, request.body)).toMatchObject({ valid: false });
  });

  it("never lets a secret, address or reply text reach a delivery, audit, outbox or notification row", async () => {
    const dump = JSON.stringify({
      deliveries: await owner`select * from webhook_deliveries where tenant_id in (${tenantA}, ${tenantB})`,
      audit: await owner`select * from audit_events where tenant_id in (${tenantA}, ${tenantB}) and action like 'webhook.%'`,
      outbox: await owner`select payload, last_error_code, dedupe_key from outbox_events where tenant_id in (${tenantA}, ${tenantB}) and event_type like 'webhook.%'`,
      notifications: await owner`select * from notifications where tenant_id = ${tenantA} and template_key = 'webhook.disabled'`,
    });
    for (const secret of allSecrets()) expect(dump).not.toContain(secret);
    expect(dump).not.toContain("hooks.example.com");
    const codes = (await owner<{ error_code: string | null }[]>`select distinct error_code from webhook_deliveries where tenant_id in (${tenantA}, ${tenantB}) and error_code is not null`).map((row) => row.error_code!);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) expect(FIXED_CODES).toContain(code);
    const audit = await owner<{ action: string; metadata: Record<string, unknown> }[]>`select action, metadata from audit_events where tenant_id = ${tenantA} and action like 'webhook.%'`;
    const actions = new Set(audit.map((row) => row.action));
    for (const action of ["webhook.endpoint.created", "webhook.endpoint.updated", "webhook.endpoint.deleted", "webhook.endpoint.secret_rotated", "webhook.endpoint.test_sent", "webhook.delivery.resent", "webhook.endpoint.disabled"]) {
      if (action !== "webhook.endpoint.deleted") expect(actions.has(action), action).toBe(true);
    }
    for (const row of audit) expect(Object.keys(row.metadata).every((key) => ["endpointId", "deliveryId", "resendOfId", "changed", "eventCount", "reason"].includes(key)), row.action).toBe(true);
    // The stored secret is sealed, not the plain text, and opens only for its own business and purpose.
    const [stored] = await owner<{ secret_ciphertext: string }[]>`select secret_ciphertext from webhook_endpoints where id = ${ids.get("main")!}`;
    expect(stored!.secret_ciphertext).toMatch(/^s1\./);
    await worker.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantA}, true)`;
      await loadDataKeys(postgresDataKeyStore(tenantDb), tenantA);
      expect(openSecret(tenantA, "webhook.endpoint", stored!.secret_ciphertext)).toBe(secrets.get("main-rotated"));
      expect(() => openSecret(tenantA, "calendar.credentials", stored!.secret_ciphertext)).toThrow();
    });
    await deleteEndpoint(ctxA, ids.get("edit")!);
    const [gone] = await owner`select 1 from webhook_endpoints where id = ${ids.get("edit")!}`;
    expect(gone).toBeUndefined();
  });
});
