/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }));

import { auth } from "@/lib/auth";
import { impersonationCookieName } from "@/lib/admin-contracts";
import { permissionKeys } from "@/lib/permissions";
import { verificationResendHandler } from "@/worker/handlers/verification-resend";
import type { MessageProvider, RenderedMessage } from "./messaging/provider";

import { queueVerificationResend, setTenantPaused } from "./admin/actions";
import { endImpersonation, resolveImpersonation, startImpersonation } from "./admin/impersonation";
import { listRollouts, setRollout } from "./admin/rollouts";
import { GET as publicAvailability } from "@/app/api/public/availability/route";
import { listAvailability } from "./appointment-repository";
import { featureEnabledFor } from "./feature-rollout";
import { getPublicClinicCatalog } from "./public-catalog";
import { assertNotReadOnlyImpersonation, getStaffContext, requirePermission } from "./staff-context";
import { listActivity } from "./staff-activity";
import { assertTenantNotPaused } from "./tenant-pause";
import { Fixture, localDatabaseReady, workerUrl, withCookie, type Person, type SignedIn } from "./admin/test-fixture";

const describeLocal = localDatabaseReady ? describe : describe.skip;
const pause = (milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds));

describeLocal("platform admin: View as this business, pause, rollout, resend", () => {
  const fixture = new Fixture();
  let tenantA = { id: "", slug: "" };
  let tenantB = { id: "", slug: "" };
  let owner: Person; let support: Person; let superUser: Person;
  let supportSession: SignedIn; let superSession: SignedIn; let ownerSession: SignedIn;

  beforeAll(async () => {
    tenantA = await fixture.tenant("imp-a");
    tenantB = await fixture.tenant("imp-b");
    owner = await fixture.person("owner", { tenantId: tenantA.id, role: "owner", verified: false });
    support = await fixture.person("sup"); superUser = await fixture.person("sup2");
    await fixture.makeOperator(support, "support"); await fixture.makeOperator(superUser, "super");
    ownerSession = await fixture.signInWithSecondFactor(owner);
    supportSession = await fixture.signInWithSecondFactor(support);
    superSession = await fixture.signInWithSecondFactor(superUser);
  });

  afterAll(async () => {
    await fixture.end();
  });

  describe("View as this business", () => {
    it("needs a reason of 10 characters, and write access needs the super role", async () => {
      await expect(startImpersonation(support.id, tenantA.id, "too short", false)).rejects.toMatchObject({ status: 400 });
      await expect(startImpersonation(support.id, tenantA.id, "Customer cannot see their bookings", true)).rejects.toMatchObject({ status: 404 });
      await expect(startImpersonation(support.id, randomUUID(), "Customer cannot see their bookings", false)).rejects.toMatchObject({ status: 404 });
    });

    it("lasts exactly 30 minutes, stores only the hash of the token, and cannot be resolved by another operator", async () => {
      const started = await startImpersonation(support.id, tenantA.id, "Customer cannot see their bookings", false);
      const [row] = await fixture.owner<{ minutes: number; token_hash: string }[]>`select extract(epoch from ends_at - created_at)::int / 60 as minutes, token_hash from impersonation_sessions where id = ${started.sessionId}`;
      expect(row?.minutes).toBe(30);
      expect(row?.token_hash).toHaveLength(64);
      expect(row?.token_hash).not.toContain(started.token);
      await expect(resolveImpersonation(support.id, started.token)).resolves.toMatchObject({ tenantId: tenantA.id, writeAccess: false });
      await expect(resolveImpersonation(superUser.id, started.token)).resolves.toBeNull();
      await expect(resolveImpersonation(support.id, "not-the-token-not-the-token")).resolves.toBeNull();
      await endImpersonation(support.id, started.sessionId);
    });

    it("gives a read-only owner view with the banner, refuses every write, and stops the moment the session ends or expires", async () => {
      const started = await startImpersonation(support.id, tenantA.id, "Customer cannot see their bookings", false);
      const headers = withCookie(supportSession, impersonationCookieName, started.token, { "x-pathname": `/clinic/${randomUUID()}` });
      const context = await getStaffContext(headers);
      expect(context).toMatchObject({ tenantId: tenantA.id, role: "owner", userId: support.id, userName: "Kalendr support", impersonation: { sessionId: started.sessionId, writeAccess: false, businessName: "Business imp-a" } });
      expect(context.userEmail).not.toBe(support.email);
      expect(context.permissions).toEqual(["records.view", "schedule.read", "audit.view"]);
      expect(() => requirePermission(context, "settings.manage")).toThrow(expect.objectContaining({ code: "read_only_support_session" }));
      expect(() => assertNotReadOnlyImpersonation(context)).toThrow(/read-only/);
      expect(() => requirePermission(context, "records.view")).not.toThrow();

      // The same session for another business's slug is not honoured.
      await expect(getStaffContext(headers, `other-${tenantB.slug}`)).rejects.toMatchObject({ status: 403 });
      // The cookie of one operator means nothing to another, and nothing without second factor.
      await expect(getStaffContext(withCookie(superSession, impersonationCookieName, started.token))).rejects.toMatchObject({ status: 403 });
      await fixture.owner`update auth_sessions set second_factor_at = null where token = ${supportSession.token}`;
      await expect(getStaffContext(headers)).rejects.toMatchObject({ status: 403 });
      await fixture.owner`update auth_sessions set second_factor_at = now() where token = ${supportSession.token}`;

      // Expiry: move the whole window into the past (the check constraint only allows a window of at most 30 minutes).
      await fixture.owner`update impersonation_sessions set created_at = now() - interval '2 hours', ends_at = now() - interval '90 minutes' where id = ${started.sessionId}`;
      await expect(getStaffContext(headers)).rejects.toMatchObject({ status: 403 });
      await expect(resolveImpersonation(support.id, started.token)).resolves.toBeNull();
    });

    it("lets a super operator ask for write access, with the full owner set except people and privacy", async () => {
      const started = await startImpersonation(superUser.id, tenantA.id, "Fix the opening hours for the owner", true);
      const context = await getStaffContext(withCookie(superSession, impersonationCookieName, started.token));
      expect(context.impersonation?.writeAccess).toBe(true);
      expect(context.permissions).toEqual(permissionKeys.filter((key) => key !== "team.manage" && key !== "privacy.manage"));
      expect(() => requirePermission(context, "settings.manage")).not.toThrow();
      expect(() => requirePermission(context, "team.manage")).toThrow(expect.objectContaining({ status: 403, code: "forbidden" }));
      await endImpersonation(superUser.id, started.sessionId);
      await expect(getStaffContext(withCookie(superSession, impersonationCookieName, started.token))).rejects.toMatchObject({ status: 403 });
    });

    it("records each viewed path once a minute, path only, and never blocks the view", async () => {
      const started = await startImpersonation(support.id, tenantA.id, "Checking the schedule view", false);
      const path = `/clinic/${randomUUID()}/schedule`;
      const headers = withCookie(supportSession, impersonationCookieName, started.token, { "x-pathname": path });
      await getStaffContext(headers);
      await getStaffContext(headers);
      await getStaffContext(withCookie(supportSession, impersonationCookieName, started.token, { "x-pathname": `${path}/other` }));
      await pause(400);
      const views = await fixture.owner<{ metadata: { path: string } }[]>`select metadata from platform_audit_events where action = 'admin.impersonation.view' and metadata ->> 'sessionId' = ${started.sessionId}`;
      expect(views.map((view) => view.metadata.path).sort()).toEqual([path, `${path}/other`].sort());
      await endImpersonation(support.id, started.sessionId);
    });

    it("shows the session in the business's own Activity log, with the reason, as Kalendr support and without the operator's name", async () => {
      const started = await startImpersonation(support.id, tenantA.id, "Why was the reminder not sent?", false);
      await endImpersonation(support.id, started.sessionId);
      const ownerContext = await getStaffContext(ownerSession.headers).catch(() => null);
      expect(ownerContext).toBeNull();
      // The owner has not verified their email; the activity API needs only a context for the business.
      const page = await listActivity({
        tenantId: tenantA.id, clinicSlug: tenantA.slug, clinicName: "Business imp-a", role: "owner", permissions: [...permissionKeys],
        membershipId: null, userId: owner.id, userName: owner.name, userEmail: owner.email, preview: false,
      });
      const begun = page.entries.find((entry) => entry.summary.startsWith("Kalendr support started a session") && entry.changes.includes("Reason: Why was the reminder not sent?"));
      expect(begun).toMatchObject({ actor: "Kalendr support", support: true });
      expect(page.entries.some((entry) => entry.summary === "Kalendr support ended a session" && entry.support)).toBe(true);
      expect(JSON.stringify(page.entries)).not.toContain(support.name);
      expect(JSON.stringify(page.entries)).not.toContain(support.email);
    });
  });

  describe("pause", () => {
    it("hides the public page and stops bookings while paused, keeps staff working, and restores it on resume", async () => {
      expect(await getPublicClinicCatalog(tenantB.slug)).not.toBeNull();
      await setTenantPaused(support.id, tenantB.id, true, "Reported as spam by several people");
      expect(await getPublicClinicCatalog(tenantB.slug)).toBeNull();
      expect(await getPublicClinicCatalog(tenantB.slug, { includeInactive: true })).not.toBeNull();
      await expect(assertTenantNotPaused(tenantB.id)).rejects.toMatchObject({ status: 409, code: "business_paused", message: "This page is not taking bookings right now." });
      // Public availability says so; staff availability (the same engine) is untouched.
      const query = `clinicSlug=${tenantB.slug}&locationId=${randomUUID()}&serviceId=${randomUUID()}&practitionerId=first_available&from=2026-12-01T00:00:00.000Z&to=2026-12-02T00:00:00.000Z`;
      const publicResponse = await publicAvailability(new Request(`http://localhost:3000/api/public/availability?${query}`, { headers: { "x-forwarded-for": "198.51.100.77" } }));
      expect(publicResponse.status).toBe(409);
      expect(await listAvailability({ clinicSlug: tenantB.slug, locationId: randomUUID(), serviceId: randomUUID(), practitionerId: "first_available", from: "2026-12-01T00:00:00.000Z", to: "2026-12-02T00:00:00.000Z" }).catch((error: unknown) => error)).not.toMatchObject({ code: "business_paused" });
      const staffB = await fixture.person("staffb", { tenantId: tenantB.id, role: "receptionist" });
      const session = await fixture.signIn(staffB);
      await expect(getStaffContext(session.headers)).resolves.toMatchObject({ tenantId: tenantB.id });
      await setTenantPaused(support.id, tenantB.id, false, "Checked and cleared by support");
      expect(await getPublicClinicCatalog(tenantB.slug)).not.toBeNull();
      await expect(assertTenantNotPaused(tenantB.id)).resolves.toBeUndefined();
      await expect(setTenantPaused(support.id, tenantB.id, true, "no")).rejects.toMatchObject({ status: 400 });
    });
  });

  describe("feature rollout", () => {
    const feature = `feature_${suffixOf()}`;
    function suffixOf(): string { return randomUUID().slice(0, 6); }

    it("lets only super change it, and layers the business's own switch on top", async () => {
      await expect(setRollout(support.id, { featureKey: feature, mode: "all", percent: 0, tenantIds: [], reason: "Not allowed" })).rejects.toMatchObject({ status: 404 });
      await setRollout(superUser.id, { featureKey: feature, mode: "off", percent: 0, tenantIds: [], reason: "Created as off" });
      expect(await featureEnabledFor(tenantA.id, feature)).toBe(false);
      await setRollout(superUser.id, { featureKey: feature, mode: "all", percent: 0, tenantIds: [], reason: "Everyone gets it" });
      expect(await featureEnabledFor(tenantA.id, feature)).toBe(true);
      expect(await featureEnabledFor(tenantA.id, feature, { [feature]: false })).toBe(false);
      await setRollout(superUser.id, { featureKey: feature, mode: "off", percent: 0, tenantIds: [], reason: "Switched back off" });
      expect(await featureEnabledFor(tenantA.id, feature, { [feature]: true })).toBe(true);
    });

    it("switches a new feature on for one business only when listed", async () => {
      await setRollout(superUser.id, { featureKey: feature, mode: "listed", percent: 0, tenantIds: [tenantA.id], reason: "Trial with business A" });
      expect(await featureEnabledFor(tenantA.id, feature)).toBe(true);
      expect(await featureEnabledFor(tenantB.id, feature)).toBe(false);
      expect((await listRollouts()).find((row) => row.featureKey === feature)).toMatchObject({ mode: "listed", tenantIds: [tenantA.id] });
    });

    it("rolls out by percentage with a stable answer for each business", async () => {
      await setRollout(superUser.id, { featureKey: feature, mode: "percent", percent: 0, tenantIds: [], reason: "Zero percent" });
      expect(await featureEnabledFor(tenantA.id, feature)).toBe(false);
      await setRollout(superUser.id, { featureKey: feature, mode: "percent", percent: 100, tenantIds: [], reason: "Hundred percent" });
      expect(await featureEnabledFor(tenantA.id, feature)).toBe(true);
      await setRollout(superUser.id, { featureKey: feature, mode: "percent", percent: 50, tenantIds: [], reason: "Half of businesses" });
      const first = await featureEnabledFor(tenantA.id, feature);
      expect(await featureEnabledFor(tenantA.id, feature)).toBe(first);
    });
  });

  describe("resend verification email", () => {
    it("queues one email per Idempotency-Key and records one action, without reading the address", async () => {
      const key = `resend-${randomUUID()}`;
      await expect(queueVerificationResend(support.id, tenantA.id, "Owner says the link expired", key)).resolves.toEqual({ queued: true, alreadyVerified: false });
      await expect(queueVerificationResend(support.id, tenantA.id, "Owner says the link expired", key)).resolves.toEqual({ queued: true, alreadyVerified: false });
      const events = await fixture.owner<{ payload: unknown }[]>`select payload from outbox_events where tenant_id = ${tenantA.id} and event_type = 'account.verification.resend' and aggregate_id = ${owner.id}`;
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events[0]?.payload)).not.toContain("@");
      const [{ actions }] = await fixture.owner<{ actions: number }[]>`select count(*)::int as actions from platform_audit_events where action = 'admin.tenant.resend_verification' and tenant_id = ${tenantA.id}`;
      expect(actions).toBe(1);
    });

    it("is sent by the worker with its own role, once, and dropped when already verified", async () => {
      const sent: RenderedMessage[] = [];
      const provider: MessageProvider = { channel: "email", send: async (message) => { sent.push(message); return { providerMessageId: "fake" }; } };
      const handler = verificationResendHandler({ sink: undefined as never, now: () => new Date(), email: { provider, fallbackReplyTo: null } });
      const worker = postgres(workerUrl ?? "", { max: 1, prepare: false, onnotice: () => {} });
      try {
        const [event] = await fixture.owner<{ id: string }[]>`select id from outbox_events where tenant_id = ${tenantA.id} and event_type = 'account.verification.resend' limit 1`;
        const run = () => worker.begin(async (transaction) => {
          await transaction`select set_config('app.tenant_id', ${tenantA.id}, true)`;
          return handler(transaction, { id: event?.id ?? "", tenantId: tenantA.id, aggregateType: "user", aggregateId: owner.id, eventType: "account.verification.resend", payload: {}, dedupeKey: "k", attemptCount: 0 });
        });
        await expect(run()).resolves.toBe("delivered");
        expect(sent).toHaveLength(1);
        expect(sent[0]?.to).toBe(owner.email);
        expect(sent[0]?.html).toContain("/api/auth/verify-email?token=");
        // The link must really verify: hand its token to Better Auth the way the browser would.
        const token = /verify-email\?token=([^&"\s]+)/.exec(sent[0]?.html ?? "")?.[1];
        expect(token).toBeTruthy();
        await auth.api.verifyEmail({ query: { token: decodeURIComponent(token ?? "") } });
        const [{ verified }] = await fixture.owner<{ verified: boolean }[]>`select email_verified as verified from auth_users where id = ${owner.id}`;
        expect(verified).toBe(true);
        await expect(run()).resolves.toBe("delivered");
        expect(sent).toHaveLength(1);
        await expect(queueVerificationResend(support.id, tenantA.id, "Already fine now", `resend-${randomUUID()}`)).resolves.toEqual({ queued: false, alreadyVerified: true });
      } finally {
        await worker.end();
      }
    });
  });
});
