/** @vitest-environment node */

import { createHash, randomBytes, randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resolvePermissions, type StaffRole } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";
import { isolatedDatabaseReady } from "@/test/isolated-database";

vi.mock("server-only", () => ({}));

import { POST as tokenRoute } from "@/app/api/oauth/token/route";
import { POST as singleUseLinkRoute } from "@/app/api/ext/single-use-links/route";
import { GET as todayRoute } from "@/app/api/ext/today/route";
import { GET as servicesRoute } from "@/app/api/ext/services/route";
import { GET as v1ServicesRoute } from "@/app/api/v1/services/route";
import { GET as v1AppointmentsRoute } from "@/app/api/v1/appointments/route";
import { getApiKeyContext } from "@/server/api-key-context";
import { decideConsent, prepareConsent } from "@/server/oauth/authorize";
import { POST as deviceStartRoute } from "@/app/api/oauth/device/route";
import { decideDevice, previewDevice } from "@/server/oauth/device";
import { createClient, listClients, revokeClient } from "@/server/oauth/clients";
import { listGrants, revokeGrant } from "@/server/oauth/grants";

const describeLocal = isolatedDatabaseReady(process.env.DATABASE_URL, process.env.KALENDR_TEST_OWNER_URL) ? describe : describe.skip;

const extensionRedirect = `https://${"a".repeat(32)}.chromiumapp.org/cb`;
// Request limits live in the database, so each run counts from its own addresses and a re-run within the minute is not refused.
const octet = () => 1 + Math.floor(Math.random() * 250);
const runIp = (group: number) => `198.51.${group}.${octet()}`;
const tokenIp = runIp(100);
const bearerIp = runIp(101);
const deviceIp = runIp(102);
const verifier = randomBytes(40).toString("base64url");
const challengeOf = (value: string) => createHash("sha256").update(value).digest("base64url");

describeLocal("OAuth grants and scoped tokens", () => {
  let owner: postgres.Sql;
  let tenantA = "";
  let tenantB = "";
  let ownerUserA = "";
  let practitionerUserA = "";
  let serviceId = "";

  const context = (tenantId: string, userId: string, role: StaffRole, stepUp = true): StaffContext => ({
    tenantId, clinicSlug: "x", clinicName: "X", role, permissions: resolvePermissions(role, {}),
    membershipId: null, userId, userName: "Desk", userEmail: "test@example.com", preview: false,
    secondFactorEnrolled: true, secondFactorAt: stepUp ? new Date() : null,
  });
  const authorizeQuery = (overrides: Record<string, string> = {}) => ({
    response_type: "code", client_id: "kalendr-extension", redirect_uri: extensionRedirect, state: "xyz",
    code_challenge: challengeOf(verifier), code_challenge_method: "S256", ...overrides,
  });
  const tokenRequest = (fields: Record<string, string>) => new Request("http://localhost/api/oauth/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": tokenIp }, body: new URLSearchParams(fields).toString(),
  });
  const bearer = (token: string) => new Request("http://localhost/api/ext/today", { headers: { authorization: `Bearer ${token}`, "x-forwarded-for": bearerIp } });

  async function connectExtension(user: string, role: StaffRole = "owner") {
    const { redirectTo } = await decideConsent(context(tenantA, user, role), authorizeQuery(), true);
    const code = new URL(redirectTo).searchParams.get("code")!;
    const response = await tokenRoute(tokenRequest({ grant_type: "authorization_code", code, redirect_uri: extensionRedirect, client_id: "kalendr-extension", code_verifier: verifier }));
    return { code, response, body: (await response.clone().json()) as Record<string, unknown> };
  }

  beforeAll(async () => {
    owner = postgres(process.env.KALENDR_TEST_OWNER_URL!, { max: 2, prepare: false });
    const [a] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    const [b] = await owner<{ id: string }[]>`select id from tenants where slug = 'riverbend-care'`;
    tenantA = a!.id; tenantB = b!.id;
    const [ownerA] = await owner<{ user_id: string }[]>`select user_id from memberships where tenant_id = ${tenantA} and role = 'owner'`;
    const [staffA] = await owner<{ user_id: string }[]>`select user_id from memberships where tenant_id = ${tenantA} and role = 'practitioner' limit 1`;
    ownerUserA = ownerA!.user_id; practitionerUserA = staffA!.user_id;
    const [service] = await owner<{ id: string }[]>`select id from services where tenant_id = ${tenantA} and is_active order by id limit 1`;
    serviceId = service!.id;
    await owner`delete from oauth_grants where tenant_id in (${tenantA}, ${tenantB})`;
    await owner`delete from oauth_clients where tenant_id in (${tenantA}, ${tenantB})`;
    // The per-person limit on typing codes is kept in the database; start each run with it clear.
    await owner`delete from rate_limit_buckets`;
  });

  afterAll(async () => {
    await owner`delete from audit_events where tenant_id in (${tenantA}, ${tenantB}) and action like 'oauth_%'`;
    await owner`delete from special_links where tenant_id = ${tenantA} and label = 'From the browser extension'`;
    await owner`delete from oauth_grants where tenant_id in (${tenantA}, ${tenantB})`;
    await owner`delete from oauth_clients where tenant_id in (${tenantA}, ${tenantB})`;
    await owner.end();
  });

  it("shows an app what it asks for and refuses an address it does not know", async () => {
    const shown = await prepareConsent(context(tenantA, ownerUserA, "owner"), authorizeQuery());
    expect(shown.consent.clientName).toBe("Kalendr browser extension");
    expect(shown.consent.scopes.map((scope) => scope.scope).sort()).toEqual(["bookings:today", "links:write", "services:read"]);
    await expect(prepareConsent(context(tenantA, ownerUserA, "owner"), authorizeQuery({ redirect_uri: "https://evil.example.com/cb" }))).rejects.toMatchObject({ code: "invalid_authorization_request" });
    await expect(prepareConsent(context(tenantA, ownerUserA, "owner"), authorizeQuery({ scope: "customers:read" }))).rejects.toMatchObject({ code: "invalid_authorization_request" });
    await expect(prepareConsent(context(tenantA, ownerUserA, "owner"), authorizeQuery({ code_challenge_method: "plain" }))).rejects.toMatchObject({ code: "invalid_authorization_request" });
  });

  it("gives a person only the scopes they could use themselves", async () => {
    const shown = await prepareConsent(context(tenantA, practitionerUserA, "practitioner"), authorizeQuery());
    // A practitioner may read the schedule but not make booking links.
    expect(shown.consent.scopes.map((scope) => scope.scope).sort()).toEqual(["bookings:today", "services:read"]);
  });

  it("swaps a code for tokens with PKCE, and the code works once", async () => {
    const { code, response, body } = await connectExtension(ownerUserA);
    expect(response.status).toBe(200);
    expect(body.access_token).toMatch(/^kat_[A-Za-z0-9_-]{43}$/);
    expect(body.refresh_token).toMatch(/^krt_/);
    expect(body.token_type).toBe("Bearer");
    const [row] = await owner<{ token_hash: string }[]>`select token_hash from oauth_tokens where kind = 'access' order by created_at desc limit 1`;
    expect(row!.token_hash).toBe(createHash("sha256").update(String(body.access_token)).digest("hex"));
    expect(row!.token_hash).not.toBe(body.access_token);
    const replay = await tokenRoute(tokenRequest({ grant_type: "authorization_code", code, redirect_uri: extensionRedirect, client_id: "kalendr-extension", code_verifier: verifier }));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
    // The replay shut down what the first use opened.
    const after = await v1ServicesRoute(new Request("http://localhost/api/v1/services", { headers: { authorization: `Bearer ${body.access_token}` } }), { params: Promise.resolve({}) });
    expect(after.status).toBe(401);
  });

  it("refuses a wrong verifier, a wrong redirect and a wrong client", async () => {
    const { redirectTo } = await decideConsent(context(tenantA, ownerUserA, "owner"), authorizeQuery(), true);
    const code = new URL(redirectTo).searchParams.get("code")!;
    const base = { grant_type: "authorization_code", code, redirect_uri: extensionRedirect, client_id: "kalendr-extension", code_verifier: verifier };
    expect((await tokenRoute(tokenRequest({ ...base, code_verifier: randomBytes(40).toString("base64url") }))).status).toBe(400);
    expect((await tokenRoute(tokenRequest({ ...base, redirect_uri: `https://${"b".repeat(32)}.chromiumapp.org/cb` }))).status).toBe(400);
    expect((await tokenRoute(tokenRequest({ ...base, client_id: "someone-else" }))).status).toBe(400);
    expect((await tokenRoute(tokenRequest(base))).status).toBe(200);
  });

  it("enforces scopes on the token and stops at once when the approval is revoked", async () => {
    const { body } = await connectExtension(ownerUserA);
    const access = String(body.access_token);
    expect((await todayRoute(bearer(access), { params: Promise.resolve({}) })).status).toBe(200);
    expect((await servicesRoute(bearer(access), { params: Promise.resolve({}) })).status).toBe(200);
    // Not granted: reading appointments or customers through the full API.
    const refused = await v1AppointmentsRoute(bearer(access), { params: Promise.resolve({}) });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "insufficient_scope" } });
    await expect(getApiKeyContext(new Headers({ authorization: `Bearer ${access}` }), "customers:read")).rejects.toMatchObject({ code: "insufficient_scope" });

    const grants = await listGrants(context(tenantA, ownerUserA, "owner"));
    const mine = grants.grants.find((grant) => grant.mine && grant.clientName === "Kalendr browser extension")!;
    await revokeGrant(context(tenantA, ownerUserA, "owner"), mine.id);
    expect((await todayRoute(bearer(access), { params: Promise.resolve({}) })).status).toBe(401);
    const refresh = await tokenRoute(tokenRequest({ grant_type: "refresh_token", refresh_token: String(body.refresh_token), client_id: "kalendr-extension" }));
    expect(refresh.status).toBe(400);
  });

  it("narrows a token as soon as the person who approved it loses the permission", async () => {
    const { body } = await connectExtension(practitionerUserA, "practitioner");
    const access = String(body.access_token);
    expect((await todayRoute(bearer(access), { params: Promise.resolve({}) })).status).toBe(200);
    const [member] = await owner<{ id: string; role: string }[]>`select id, role from memberships where tenant_id = ${tenantA} and user_id = ${practitionerUserA}`;
    try {
      // Moved to read-only: no schedule any more, so the approval's bookings:today scope no longer counts.
      await owner`update memberships set role = 'read_only' where id = ${member!.id}`;
      const refused = await todayRoute(bearer(access), { params: Promise.resolve({}) });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: { code: "insufficient_scope" } });
    } finally {
      await owner`update memberships set role = ${member!.role}::membership_role where id = ${member!.id}`;
    }
    expect((await todayRoute(bearer(access), { params: Promise.resolve({}) })).status).toBe(200);
    await owner`update oauth_grants set revoked_at = now() where tenant_id = ${tenantA} and user_id = ${practitionerUserA} and revoked_at is null`;
  });

  it("rotates refresh tokens and treats a reused one as stolen", async () => {
    const { body } = await connectExtension(ownerUserA);
    const first = await tokenRoute(tokenRequest({ grant_type: "refresh_token", refresh_token: String(body.refresh_token), client_id: "kalendr-extension" }));
    expect(first.status).toBe(200);
    const next = (await first.json()) as Record<string, string>;
    expect(next.refresh_token).not.toBe(body.refresh_token);
    const replay = await tokenRoute(tokenRequest({ grant_type: "refresh_token", refresh_token: String(body.refresh_token), client_id: "kalendr-extension" }));
    expect(replay.status).toBe(400);
    // The new token went down with the grant.
    expect((await todayRoute(bearer(next.access_token!), { params: Promise.resolve({}) })).status).toBe(401);
  });

  it("lets only the person or someone who manages apps revoke an approval, and not across businesses", async () => {
    await connectExtension(ownerUserA);
    const [grant] = await owner<{ id: string }[]>`select id from oauth_grants where tenant_id = ${tenantA} and revoked_at is null limit 1`;
    await expect(revokeGrant(context(tenantA, practitionerUserA, "practitioner"), grant!.id)).rejects.toMatchObject({ status: 403 });
    await expect(revokeGrant(context(tenantB, ownerUserA, "owner"), grant!.id)).rejects.toMatchObject({ status: 404 });
    expect((await listGrants(context(tenantB, ownerUserA, "owner"))).grants).toEqual([]);
  });

  it("creates a single-use link through the extension scope, and shows first names only", async () => {
    const { body } = await connectExtension(ownerUserA);
    const access = String(body.access_token);
    const created = await singleUseLinkRoute(new Request("http://localhost/api/ext/single-use-links", {
      method: "POST", headers: { authorization: `Bearer ${access}`, "content-type": "application/json" }, body: JSON.stringify({ serviceId }),
    }), { params: Promise.resolve({}) });
    expect(created.status).toBe(201);
    const link = (await created.json()) as { data: { url: string } };
    expect(link.data.url).toMatch(/^https?:\/\/.+\/l\/.+/);
    const [row] = await owner<{ kind: string; max_uses: number }[]>`select kind, max_uses from special_links where tenant_id = ${tenantA} and label = 'From the browser extension' limit 1`;
    expect(row).toMatchObject({ kind: "single_use", max_uses: 1 });

    const [patient] = await owner<{ id: string }[]>`
      insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel)
      values (${tenantA}, 'Zebra', 'Surnamer', '+919800000077', 'zebra-oauth@example.com', 'sms') returning id`;
    const [location] = await owner<{ id: string }[]>`select id from locations where tenant_id = ${tenantA} limit 1`;
    const [practitioner] = await owner<{ id: string }[]>`select id from practitioners where tenant_id = ${tenantA} limit 1`;
    await owner`insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash)
      values (${tenantA}, ${location!.id}, ${patient!.id}, ${practitioner!.id}, ${serviceId}, now(), now() + interval '20 minutes', 'booked', 'staff', ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")})`;
    try {
      const today = await todayRoute(bearer(access), { params: Promise.resolve({}) });
      const text = await today.text();
      expect(text).toContain("Zebra");
      expect(text).not.toContain("Surnamer");
      expect(text).not.toContain("919800000077");
      expect(text).not.toContain("zebra-oauth@example.com");
    } finally {
      await owner`delete from appointments where tenant_id = ${tenantA} and patient_id = ${patient!.id}`;
      await owner`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where id = ${patient!.id})`;
      await owner`delete from patients where id = ${patient!.id}`;
    }
  });

  it("stops a business reading another's service through a token", async () => {
    const { body } = await connectExtension(ownerUserA);
    const response = await servicesRoute(bearer(String(body.access_token)), { params: Promise.resolve({}) });
    const names = ((await response.json()) as { data: { id: string }[] }).data.map((service) => service.id);
    const foreign = await owner<{ id: string }[]>`select id from services where tenant_id = ${tenantB}`;
    for (const service of foreign) expect(names).not.toContain(service.id);
  });

  describe("an app a business registered", () => {
    let clientId = "";
    let secret = "";
    const redirect = "https://app.example.com/callback";

    it("needs the owner and a fresh second-factor check, and keeps only the secret's hash", async () => {
      const body = { name: "Zebra CRM sync", redirectUris: [redirect], scopes: ["services:read", "appointments:read"] };
      await expect(createClient(context(tenantA, ownerUserA, "admin"), body)).rejects.toMatchObject({ code: "owner_only" });
      await expect(createClient(context(tenantA, ownerUserA, "owner", false), body)).rejects.toMatchObject({ status: 403 });
      const created = await createClient(context(tenantA, ownerUserA, "owner"), body);
      clientId = created.client.id; secret = created.secret;
      expect(secret).toMatch(/^kcs_/);
      const [row] = await owner<{ secret_hash: string }[]>`select secret_hash from oauth_clients where id = ${clientId}`;
      expect(row!.secret_hash).toBe(createHash("sha256").update(secret).digest("hex"));
      expect(JSON.stringify(await listClients(context(tenantA, ownerUserA, "owner")))).not.toContain(secret);
      await expect(createClient(context(tenantA, ownerUserA, "owner"), { ...body, redirectUris: ["http://evil.example.com/cb"] })).rejects.toMatchObject({ code: "validation_error" });
    });

    it("runs the code flow with the secret, and refuses a wrong secret or another business's client", async () => {
      const query = authorizeQuery({ client_id: clientId, redirect_uri: redirect, scope: "services:read appointments:read" });
      await expect(prepareConsent(context(tenantB, ownerUserA, "owner"), query)).rejects.toMatchObject({ code: "invalid_authorization_request" });
      await expect(prepareConsent(context(tenantA, ownerUserA, "owner"), { ...query, redirect_uri: "https://app.example.com/other" })).rejects.toMatchObject({ code: "invalid_authorization_request" });
      const { redirectTo } = await decideConsent(context(tenantA, ownerUserA, "owner"), query, true);
      const code = new URL(redirectTo).searchParams.get("code")!;
      const base = { grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier };
      expect((await tokenRoute(tokenRequest({ ...base, client_secret: "kcs_wrong" }))).status).toBe(401);
      expect((await tokenRoute(tokenRequest(base))).status).toBe(401);
      const ok = await tokenRoute(tokenRequest({ ...base, client_secret: secret }));
      expect(ok.status).toBe(200);
      const tokens = (await ok.json()) as Record<string, string>;
      expect(tokens.scope).toBe("services:read appointments:read");
      const listing = await v1AppointmentsRoute(new Request("http://localhost/api/v1/appointments", { headers: { authorization: `Bearer ${tokens.access_token}` } }), { params: Promise.resolve({}) });
      expect(listing.status).toBe(200);
      // Removing the app removes every approval and token under it.
      await revokeClient(context(tenantA, ownerUserA, "owner"), clientId);
      const afterRevoke = await v1AppointmentsRoute(new Request("http://localhost/api/v1/appointments", { headers: { authorization: `Bearer ${tokens.access_token}` } }), { params: Promise.resolve({}) });
      expect(afterRevoke.status).toBe(401);
    });
  });

  describe("device sign-in for the extension", () => {
    const deviceRequest = (fields: Record<string, string>) => new Request("http://localhost/api/oauth/device", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": deviceIp }, body: new URLSearchParams(fields).toString(),
    });
    const poll = (device: string) => tokenRoute(tokenRequest({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device, client_id: "kalendr-extension" }));
    const aged = (device: string) => owner`update oauth_device_codes set last_polled_at = now() - interval '1 minute' where device_hash = ${createHash("sha256").update(device).digest("hex")}`;
    async function start() {
      const response = await deviceStartRoute(deviceRequest({ client_id: "kalendr-extension" }));
      expect(response.status).toBe(200);
      return (await response.json()) as { device_code: string; user_code: string; verification_uri_complete: string; interval: number; expires_in: number };
    }

    it("hands out a code, waits, and gives tokens once a person approves it", async () => {
      const started = await start();
      expect(started.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
      expect(started.verification_uri_complete).toContain(started.user_code);
      expect(started.device_code).toMatch(/^kdc_/);
      const [stored] = await owner<{ device_hash: string; user_code_hash: string }[]>`select device_hash, user_code_hash from oauth_device_codes order by created_at desc limit 1`;
      expect(JSON.stringify(stored)).not.toContain(started.device_code);
      expect(JSON.stringify(stored)).not.toContain(started.user_code.replace("-", ""));

      expect(await (await poll(started.device_code)).json()).toMatchObject({ error: "authorization_pending" });
      expect(await (await poll(started.device_code)).json()).toMatchObject({ error: "slow_down" });
      await aged(started.device_code);

      const shown = await previewDevice(context(tenantA, ownerUserA, "owner"), started.user_code.toLowerCase());
      expect(shown.consent.scopes.map((scope) => scope.scope).sort()).toEqual(["bookings:today", "links:write", "services:read"]);
      expect(await decideDevice(context(tenantA, ownerUserA, "owner"), started.user_code, true)).toEqual({ approved: true });
      const done = await poll(started.device_code);
      expect(done.status).toBe(200);
      const tokens = (await done.json()) as Record<string, string>;
      expect((await todayRoute(bearer(tokens.access_token!), { params: Promise.resolve({}) })).status).toBe(200);
      // One use only.
      await aged(started.device_code);
      expect(await (await poll(started.device_code)).json()).toMatchObject({ error: "invalid_grant" });
      // And the same person disconnects it like any other approval.
      const grants = await listGrants(context(tenantA, ownerUserA, "owner"));
      await revokeGrant(context(tenantA, ownerUserA, "owner"), grants.grants.find((grant) => grant.mine)!.id);
      expect((await todayRoute(bearer(tokens.access_token!), { params: Promise.resolve({}) })).status).toBe(401);
    });

    it("gives a practitioner only what they could do themselves, and a no means no tokens", async () => {
      const started = await start();
      const shown = await previewDevice(context(tenantA, practitionerUserA, "practitioner"), started.user_code);
      expect(shown.consent.scopes.map((scope) => scope.scope).sort()).toEqual(["bookings:today", "services:read"]);
      expect(await decideDevice(context(tenantA, practitionerUserA, "practitioner"), started.user_code, false)).toEqual({ approved: false });
      await aged(started.device_code);
      expect(await (await poll(started.device_code)).json()).toMatchObject({ error: "access_denied" });
      await expect(previewDevice(context(tenantA, ownerUserA, "owner"), started.user_code)).rejects.toMatchObject({ code: "code_not_found" });
    });

    it("refuses a wrong or malformed code, an unknown client and a code that ran out", async () => {
      await expect(previewDevice(context(tenantA, ownerUserA, "owner"), "BCDF-GHJK")).rejects.toMatchObject({ code: "code_not_found" });
      await expect(previewDevice(context(tenantA, ownerUserA, "owner"), "hello")).rejects.toMatchObject({ code: "code_not_found" });
      expect((await deviceStartRoute(deviceRequest({ client_id: "someone-else" }))).status).toBe(401);
      expect((await deviceStartRoute(deviceRequest({ client_id: "kalendr-extension", scope: "customers:read" }))).status).toBe(400);
      const started = await start();
      await owner`update oauth_device_codes set expires_at = now() - interval '1 second' where device_hash = ${createHash("sha256").update(started.device_code).digest("hex")}`;
      await aged(started.device_code);
      expect(await (await poll(started.device_code)).json()).toMatchObject({ error: "expired_token" });
      await expect(decideDevice(context(tenantA, ownerUserA, "owner"), started.user_code, true)).rejects.toMatchObject({ code: "code_not_found" });
    });

    it("cannot be read or changed directly by the app's database role", async () => {
      const runtime = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
      try {
        await start();
        expect(await runtime`select * from oauth_device_codes`).toHaveLength(0);
        await expect(runtime`insert into oauth_device_codes (device_hash, user_code_hash, client_id, scopes, expires_at) values ('a', 'b', 'c', '{}', now())`).rejects.toThrow();
      } finally {
        await runtime.end();
      }
    });
  });
});
