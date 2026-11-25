/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resolvePermissions, type StaffRole } from "@/lib/permissions";
import { isolatedDatabaseReady } from "@/test/isolated-database";
import type { StaffContext } from "@/server/staff-context";

vi.mock("server-only", () => ({}));

import { checkApp, getAppDetail, installApp, listApps, replaceAppCredentials, setAppStatus, uninstallApp, updateAppSettings } from "@/server/apps/admin";
import type { AppRequest } from "@/server/apps/types";
import type { AppTransport, AppTransportResult } from "@/server/apps/transport";
import { createAppTransport } from "@/server/apps/transport";

import { localCaptureSink } from "./delivery";
import { createHandlers, type HandlerRegistry } from "./handlers";
import { claimOutboxBatch, processClaimedEvent, releaseClaims } from "./outbox-worker";
import { fanOutWebhooks } from "./webhooks/fanout";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeLocal = isolatedDatabaseReady(runtimeUrl, ownerUrl, workerUrl) ? describe : describe.skip;

const OURS = ["app.deliver", "app.check", "app.remove"];
const slackToken = `xoxb-${"1234567890".repeat(3)}-secretvalue`;
const hubspotToken = `pat-na1-${"abcdef0123".repeat(3)}`;

/** Records every request and answers from a script, then with a fallback. Never touches the network. */
class FakeTransport implements AppTransport {
  readonly requests: AppRequest[] = [];
  readonly script: AppTransportResult[] = [];
  fallback: AppTransportResult = { kind: "response", statusCode: 200, body: '{"ok":true}' };
  async send(request: AppRequest): Promise<AppTransportResult> {
    this.requests.push(request);
    return this.script.shift() ?? this.fallback;
  }
  to(fragment: string): AppRequest[] { return this.requests.filter((request) => request.url.includes(fragment)); }
}

describeLocal("installed apps", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  const suffix = randomUUID().slice(0, 8);
  let tenantA = "";
  let tenantB = "";
  let appointmentId = "";
  let patientId = "";
  let serviceName = "";
  const transport = new FakeTransport();
  const handlers = (): HandlerRegistry => createHandlers({ sink: localCaptureSink, now: () => new Date(), apps: { transport, retryDelaysMs: [0, 0, 0], disableAfterFailures: 4 } });
  let eventCount = 0;

  const context = (tenantId: string, role: StaffRole = "owner"): StaffContext => ({
    tenantId, clinicSlug: "x", clinicName: "X", role, permissions: resolvePermissions(role, {}),
    membershipId: null, userId: null, userName: "Owner", userEmail: "owner@example.com", preview: false,
    secondFactorEnrolled: true, secondFactorAt: new Date(),
  });

  async function drain(rounds = 12): Promise<number> {
    let processed = 0;
    for (let round = 0; round < rounds; round += 1) {
      const claims = await claimOutboxBatch(worker, `apps-test-${suffix}`, 200);
      const types = claims.length === 0 ? [] : await owner<{ id: string; event_type: string }[]>`select id, event_type from outbox_events where id in ${owner(claims.map((claim) => claim.id))}`;
      const ours = new Set(types.filter((row) => OURS.includes(row.event_type)).map((row) => row.id));
      const mine = claims.filter((claim) => ours.has(claim.id) && [tenantA, tenantB].includes(claim.tenantId));
      await releaseClaims(worker, claims.filter((claim) => !mine.includes(claim)));
      if (mine.length === 0) return processed;
      for (const claim of mine) { await processClaimedEvent(worker, claim, { handlers: handlers() }); processed += 1; }
    }
    return processed;
  }

  /** Rows the worker set aside to retry later are made due now, so a test need not wait out the real backoff. */
  async function drainRetries(): Promise<void> {
    for (let round = 0; round < 6; round += 1) {
      const due = await owner`update outbox_events set available_at = now() where event_type = any(${OURS}) and status = 'failed' returning id`;
      if (due.length === 0) return;
      await drain();
    }
  }

  /** Plays a booking change through the same fan-out the worker runs for every real one. */
  async function bookingChange(type: string, tenantId = tenantA, aggregateType = "appointment", aggregateId = appointmentId) {
    eventCount += 1;
    await worker.begin(async (transaction) => {
      await transaction`select set_config('app.tenant_id', ${tenantId}, true)`;
      await fanOutWebhooks(transaction, {
        id: randomUUID(), tenantId, aggregateType, aggregateId, eventType: type, payload: { version: 1 }, dedupeKey: `apps-test:${suffix}:${eventCount}`, attemptCount: 0,
      }, new Date());
    });
    await drain();
  }

  const installRow = async (key: string, tenantId = tenantA) => (await owner<Record<string, unknown>[]>`select * from app_installs where tenant_id = ${tenantId} and app_key = ${key}`)[0];
  const events = (key: string, tenantId = tenantA) => owner<{ event_type: string; outcome: string; error_code: string | null }[]>`
    select event_type, outcome, error_code from app_events where tenant_id = ${tenantId} and app_key = ${key} order by created_at, id`;
  const reset = () => { transport.requests.length = 0; transport.script.length = 0; transport.fallback = { kind: "response", statusCode: 200, body: '{"ok":true}' }; };

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    worker = postgres(workerUrl!, { max: 4, prepare: false, onnotice: () => undefined });
    const [a] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    const [b] = await owner<{ id: string }[]>`select id from tenants where slug = 'riverbend-care'`;
    tenantA = a!.id; tenantB = b!.id;
    await owner`delete from app_installs where tenant_id in (${tenantA}, ${tenantB})`;
    await owner`delete from app_events where tenant_id in (${tenantA}, ${tenantB})`;
    const [service] = await owner<{ id: string; name: string }[]>`select id, name from services where tenant_id = ${tenantA} and is_active order by id limit 1`;
    serviceName = service!.name;
    const [location] = await owner<{ id: string }[]>`select id from locations where tenant_id = ${tenantA} limit 1`;
    const [practitioner] = await owner<{ id: string }[]>`select id from practitioners where tenant_id = ${tenantA} limit 1`;
    // Consent history can never be deleted, so a customer who has some is kept between runs and left withdrawn.
    const [known] = await owner<{ id: string }[]>`select id from patients where tenant_id = ${tenantA} and email = 'zebra-apps@example.com'`;
    const [patient] = known ? [known] : await owner<{ id: string }[]>`
      insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel)
      values (${tenantA}, 'Zebra', 'Surnamer', '+919800000088', 'zebra-apps@example.com', 'sms') returning id`;
    patientId = patient!.id;
    const [appointment] = await owner<{ id: string }[]>`
      insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash)
      values (${tenantA}, ${location!.id}, ${patientId}, ${practitioner!.id}, ${service!.id}, now() + interval '2 days', now() + interval '2 days 20 minutes', 'booked', 'staff',
        ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")}) returning id`;
    appointmentId = appointment!.id;
  });

  afterAll(async () => {
    await owner`delete from app_installs where tenant_id in (${tenantA}, ${tenantB})`;
    await owner`delete from app_events where tenant_id in (${tenantA}, ${tenantB})`;
    await owner`delete from audit_events where tenant_id in (${tenantA}, ${tenantB}) and action like 'app.%'`;
    await owner`delete from outbox_events where dedupe_key like ${`apps-test:${suffix}:%`}`;
    await owner`delete from appointments where id = ${appointmentId}`;
    await owner`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where id = ${patientId})`.catch(() => undefined);
    await owner`delete from patients where id = ${patientId}`.catch(() => undefined);
    await owner.end();
    await worker.end();
  });

  it("lists the apps and the existing integrations together", async () => {
    const { apps } = await listApps(context(tenantA));
    const keys = apps.map((app) => app.key);
    expect(keys).toEqual(expect.arrayContaining(["slack", "hubspot", "google-analytics", "google-calendar", "online-payments", "whatsapp", "webhooks", "api-keys", "website-embed"]));
    expect(apps.find((app) => app.key === "slack")).toMatchObject({ kind: "native", state: "available" });
    expect(apps.find((app) => app.key === "webhooks")).toMatchObject({ kind: "connected", manage: { section: "developers" } });
  });

  it("needs the permission, the owner's second factor and a valid token", async () => {
    const body = { credentials: { botToken: slackToken }, settings: { channel: "#bookings" } };
    await expect(installApp(context(tenantA, "receptionist"), "slack", body)).rejects.toMatchObject({ status: 403 });
    await expect(installApp({ ...context(tenantA), secondFactorAt: null }, "slack", body)).rejects.toMatchObject({ status: 403 });
    await expect(installApp(context(tenantA), "slack", { credentials: { botToken: "nope" }, settings: {} })).rejects.toMatchObject({ code: "validation_error", fieldErrors: { "credentials.botToken": expect.any(Array) } });
    await expect(installApp(context(tenantA), "slack", { credentials: { botToken: slackToken }, settings: { channel: "not a channel!" } })).rejects.toMatchObject({ code: "validation_error" });
    await expect(installApp(context(tenantA), "nothing", body)).rejects.toMatchObject({ status: 404 });
  });

  it("connects Slack: seals the token, checks it in the worker, then posts the next booking", async () => {
    reset();
    const detail = await installApp(context(tenantA), "slack", { credentials: { botToken: slackToken }, settings: { channel: "#bookings" } });
    expect(detail.state).toBe("active");
    expect(JSON.stringify(detail)).not.toContain(slackToken);
    const row = await installRow("slack");
    expect(String(row!.credentials_ciphertext)).not.toContain(slackToken);
    expect(JSON.stringify(row!.settings)).not.toContain(slackToken);
    await drain();
    expect(transport.to("chat.postMessage")).toHaveLength(1);
    expect((await events("slack")).map((entry) => `${entry.event_type}:${entry.outcome}`)).toEqual(["check:delivered"]);

    reset();
    await bookingChange("appointment.created");
    const posts = transport.to("chat.postMessage");
    expect(posts).toHaveLength(1);
    const posted = JSON.parse(posts[0]!.body!) as { channel: string; text: string };
    expect(posted.channel).toBe("#bookings");
    expect(posted.text).toContain(serviceName);
    for (const secret of ["Zebra", "Surnamer", "919800000088", "zebra-apps@example.com"]) expect(posted.text).not.toContain(secret);
    expect(posts[0]!.headers.Authorization).toBe(`Bearer ${slackToken}`);
    expect((await events("slack")).at(-1)).toMatchObject({ event_type: "appointment.created", outcome: "delivered" });

    // Never again in the readable log: the token is not in any audit row.
    const audits = await owner<{ metadata: unknown }[]>`select metadata from audit_events where tenant_id = ${tenantA} and action like 'app.%'`;
    expect(JSON.stringify(audits)).not.toContain(slackToken);
    expect(JSON.stringify(audits)).not.toContain("#bookings");
  });

  it("adds the first name only when the owner turns it on, and ignores events it was not set to hear", async () => {
    reset();
    const before = await getAppDetail(context(tenantA), "slack");
    await updateAppSettings(context(tenantA), "slack", { settings: { channel: "#bookings", events: ["appointment.created"], showFirstName: true }, expectedVersion: before.version });
    await bookingChange("appointment.created");
    expect(JSON.parse(transport.to("chat.postMessage")[0]!.body!).text).toContain("Zebra");
    expect(JSON.parse(transport.to("chat.postMessage")[0]!.body!).text).not.toContain("Surnamer");
    reset();
    await bookingChange("appointment.cancel");
    expect(transport.requests).toHaveLength(0);
    await expect(updateAppSettings(context(tenantA), "slack", { settings: { channel: "#x", events: ["appointment.created"], showFirstName: false }, expectedVersion: before.version })).rejects.toMatchObject({ code: "version_conflict" });
  });

  it("retries a busy service, and shows what happened in plain codes", async () => {
    reset();
    transport.script.push({ kind: "response", statusCode: 503, body: "" });
    await bookingChange("appointment.created");
    expect(transport.to("chat.postMessage")).toHaveLength(2);
    const log = (await events("slack")).slice(-2);
    expect(log).toEqual([
      { event_type: "appointment.created", outcome: "failed", error_code: "service_unavailable" },
      { event_type: "appointment.created", outcome: "delivered", error_code: null },
    ]);
    expect(JSON.stringify(log)).not.toContain("503");
  });

  it("switches an app off when its key is refused, and a replaced, working key turns it back on", async () => {
    reset();
    transport.fallback = { kind: "response", statusCode: 200, body: '{"ok":false,"error":"token_revoked"}' };
    await bookingChange("appointment.created");
    expect(transport.to("chat.postMessage")).toHaveLength(1);
    expect(await installRow("slack")).toMatchObject({ status: "failing", disabled_reason: "credential_rejected" });
    reset();
    await bookingChange("appointment.created");
    expect(transport.requests).toHaveLength(0);
    const detail = await getAppDetail(context(tenantA), "slack");
    await expect(setAppStatus(context(tenantA), "slack", { status: "active", expectedVersion: detail.version })).rejects.toMatchObject({ code: "replace_key_first" });
    await replaceAppCredentials(context(tenantA), "slack", { credentials: { botToken: slackToken.replace("secretvalue", "newvalue") }, expectedVersion: detail.version });
    await drain();
    expect(await installRow("slack")).toMatchObject({ status: "active", disabled_reason: null });
  });

  it("can be paused, and uninstalling revokes the token and deletes the credentials", async () => {
    reset();
    let detail = await getAppDetail(context(tenantA), "slack");
    await setAppStatus(context(tenantA), "slack", { status: "paused", expectedVersion: detail.version });
    await bookingChange("appointment.created");
    expect(transport.requests).toHaveLength(0);
    detail = await getAppDetail(context(tenantA), "slack");
    await setAppStatus(context(tenantA), "slack", { status: "active", expectedVersion: detail.version });

    expect(await uninstallApp(context(tenantA), "slack")).toEqual({ removing: true });
    expect((await installRow("slack"))!.status).toBe("uninstalling");
    await bookingChange("appointment.created");
    expect(transport.to("chat.postMessage")).toHaveLength(0);
    expect(transport.to("auth.revoke")).toHaveLength(1);
    expect(transport.to("auth.revoke")[0]!.headers.Authorization).toContain("xoxb-");
    expect(await installRow("slack")).toBeUndefined();
    expect((await events("slack")).at(-1)).toMatchObject({ event_type: "uninstall", outcome: "delivered" });
    // Nothing is sent after removal.
    reset();
    await bookingChange("appointment.created");
    expect(transport.requests).toHaveLength(0);
  });

  it("still removes the credentials when the other service cannot be reached", async () => {
    reset();
    await installApp(context(tenantA), "slack", { credentials: { botToken: slackToken }, settings: { channel: "#bookings" } });
    await drain();
    transport.fallback = { kind: "error", errorCode: "connection_failed" };
    await uninstallApp(context(tenantA), "slack");
    await drain();
    await drainRetries();
    expect(await installRow("slack")).toBeUndefined();
    expect((await events("slack")).at(-1)).toMatchObject({ event_type: "uninstall", outcome: "failed", error_code: "revoke_failed" });
  });

  it("sends HubSpot only the mapped fields, and only for a customer who agreed to marketing", async () => {
    reset();
    await installApp(context(tenantA), "hubspot", { credentials: { accessToken: hubspotToken }, settings: {
      events: ["appointment.created"],
      fields: { email: { enabled: true, target: "email" }, firstName: { enabled: true, target: "firstname" }, lastName: { enabled: false, target: "lastname" }, phone: { enabled: false, target: "phone" } },
    } });
    await drain();
    expect(transport.to("/crm/v3/objects/contacts?limit=1")).toHaveLength(1);

    reset();
    await bookingChange("appointment.created");
    expect(transport.requests).toHaveLength(0);
    expect((await events("hubspot")).at(-1)).toMatchObject({ outcome: "skipped", error_code: "no_consent" });

    await owner`insert into consent_records (tenant_id, patient_id, purpose, granted, wording_version, source, actor_type) values (${tenantA}, ${patientId}, 'marketing_messages', true, '2026-11', 'staff', 'staff')`;
    reset();
    await bookingChange("appointment.created");
    const upserts = transport.to("batch/upsert");
    expect(upserts).toHaveLength(1);
    const body = JSON.parse(upserts[0]!.body!) as { inputs: { idProperty: string; id: string; properties: Record<string, string> }[] };
    expect(body.inputs[0]).toEqual({ idProperty: "email", id: "zebra-apps@example.com", properties: { email: "zebra-apps@example.com", firstname: "Zebra" } });
    expect(upserts[0]!.body).not.toContain("Surnamer");
    expect(upserts[0]!.body).not.toContain("919800000088");

    // A customer who later withdraws is skipped again.
    await owner`insert into consent_records (tenant_id, patient_id, purpose, granted, wording_version, source, actor_type) values (${tenantA}, ${patientId}, 'marketing_messages', false, '2026-11', 'staff', 'staff')`;
    reset();
    await bookingChange("appointment.created");
    expect(transport.requests).toHaveLength(0);
    await uninstallApp(context(tenantA), "hubspot");
    await drain();
    expect(await installRow("hubspot")).toBeUndefined();
    // HubSpot cannot be revoked from here: the app says so, and no revoke call is made.
    expect(transport.requests.filter((request) => request.url.includes("hubapi"))).toHaveLength(0);
  });

  it("sends Google Analytics an event with no customer details", async () => {
    reset();
    await installApp(context(tenantA), "google-analytics", { credentials: { apiSecret: "abcdefghij1234" }, settings: { measurementId: "G-TEST1234", events: ["appointment.created"] } });
    await drain();
    reset();
    await bookingChange("appointment.created");
    const sent = transport.to("google-analytics.com/mp/collect");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("booking_created");
    for (const secret of ["Zebra", "Surnamer", "919800000088", "zebra-apps@example.com", appointmentId]) expect(sent[0]!.body).not.toContain(secret);
    await uninstallApp(context(tenantA), "google-analytics");
    await drain();
  });

  it("keeps one business's apps out of another's", async () => {
    reset();
    await installApp(context(tenantA), "slack", { credentials: { botToken: slackToken }, settings: { channel: "#bookings" } });
    await drain();
    expect((await listApps(context(tenantB))).apps.find((app) => app.key === "slack")).toMatchObject({ state: "available" });
    await expect(getAppDetail(context(tenantB), "slack")).resolves.toMatchObject({ hasCredentials: false, events: [] });
    await expect(uninstallApp(context(tenantB), "slack")).rejects.toMatchObject({ status: 404 });
    await expect(checkApp(context(tenantB), "slack")).rejects.toMatchObject({ status: 404 });
    reset();
    // B's own booking change does not reach A's Slack.
    await bookingChange("appointment.created", tenantB, "appointment", randomUUID());
    expect(transport.requests).toHaveLength(0);
    await uninstallApp(context(tenantA), "slack");
    await drain();
  });

  it("refuses to send anywhere but the hosts an app named", async () => {
    const real = createAppTransport(async () => [{ address: "93.184.216.34", family: 4 }]);
    const refused = await real.send({ url: "https://evil.example.com/steal", method: "POST", headers: {}, body: "{}" }, { allowedHosts: ["slack.com"] });
    expect(refused).toEqual({ kind: "error", errorCode: "blocked_address" });
    const insecure = await real.send({ url: "http://slack.com/api/x", method: "POST", headers: {}, body: "{}" }, { allowedHosts: ["slack.com"] });
    expect(insecure).toEqual({ kind: "error", errorCode: "blocked_address" });
    const privateAddress = await createAppTransport(async () => [{ address: "10.0.0.5", family: 4 }]).send({ url: "https://slack.com/api/x", method: "POST", headers: {} }, { allowedHosts: ["slack.com"] });
    expect(privateAddress).toEqual({ kind: "error", errorCode: "blocked_address" });
  });
});
