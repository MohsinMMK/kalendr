/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { serviceProviderUrls } from "@/lib/sso-urls";
import { isolatedDatabaseReady } from "@/test/isolated-database";

vi.mock("server-only", () => ({}));

import { addMember, type MemberFixture } from "@/test/enterprise-fixture";
import { createTenant, staffContext, type TenantFixture } from "@/test/privacy-fixture";
import { buildSamlResponse, createTestIdp, requestIdFrom, type TestIdp } from "@/test/saml-test-idp";
import { ApiError } from "@/server/api-error";
import { appOrigin } from "@/server/env";
import { addDomain, removeSsoConnection, saveSsoConnection, setBreakGlassOwner, setSsoStatus, updateDomain } from "./domains";
import { finishSamlSignIn, lookupCompanySignIn, startCompanySignIn } from "./sso-flow";
import { newBrowserBinding, redeemSsoTicket } from "./sso-state";
import { companySignInRequiredFor } from "./sso-guard";

const describeLocal = isolatedDatabaseReady(process.env.DATABASE_URL, process.env.KALENDR_TEST_OWNER_URL) ? describe : describe.skip;

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try { await promise; } catch (error: unknown) { if (error instanceof ApiError) return error; throw error; }
  throw new Error("Expected the call to be refused.");
}

interface Company {
  tenant: TenantFixture;
  owner: MemberFixture;
  domain: string;
  domainId: string;
  connectionId: string;
  idp: TestIdp;
}

describeLocal("company sign-in with SAML", () => {
  let owner: postgres.Sql;
  let a: Company;
  let b: Company;
  let nurseA: MemberFixture;

  async function company(label: string): Promise<Company> {
    const tenant = await createTenant(owner, label);
    const ownerMember = await addMember(owner, tenant.tenantId, "owner");
    const context = staffContext(tenant, { membershipId: ownerMember.membershipId, userId: ownerMember.userId });
    const domain = `${label}-${randomUUID().slice(0, 8)}.example`;
    const added = await addDomain(context, { domain });
    await owner`update verified_domains set verified_at = now() where id = ${added.id}`;
    const idp = createTestIdp(`https://idp.${label}.example/metadata`);
    const connection = await saveSsoConnection(context, added.id, { kind: "saml", idpEntityId: idp.entityId, idpSsoUrl: `https://idp.${label}.example/sso`, idpCertificate: idp.certificate });
    await setSsoStatus(context, added.id, "active");
    return { tenant, owner: ownerMember, domain, domainId: added.id, connectionId: connection.id, idp };
  }

  /** Starts a sign-in and answers it as the provider would. Returns the path the browser is sent to. */
  async function signIn(c: Company, email: string, options: Partial<Parameters<typeof buildSamlResponse>[0]> = {}, reuse?: { response: string }): Promise<{ path: string; response: string; binding: string }> {
    const urls = serviceProviderUrls(appOrigin(), c.connectionId);
    const { binding } = newBrowserBinding();
    const started = await startCompanySignIn("saml", c.connectionId, binding);
    // The provider hands RelayState back unchanged.
    expect(new URL(started).searchParams.get("RelayState")).toBe(binding);
    const response = reuse?.response ?? buildSamlResponse({ idp: c.idp, audience: urls.entityId, acsUrl: urls.acsUrl, inResponseTo: requestIdFrom(started), email, ...options });
    return { path: await finishSamlSignIn(c.connectionId, { SAMLResponse: response, RelayState: binding }), response, binding };
  }

  beforeAll(async () => {
    owner = postgres(process.env.KALENDR_TEST_OWNER_URL!, { max: 2, prepare: false });
    a = await company("ssoa");
    b = await company("ssob");
    nurseA = await addMember(owner, a.tenant.tenantId, "receptionist", { email: `nurse@${a.domain}` });
  });

  afterAll(async () => {
    await owner`delete from tenants where id in (${a.tenant.tenantId}, ${b.tenant.tenantId})`.catch(() => undefined);
    await owner.end();
  });

  it("finds the company sign-in from an email address, and nothing else", async () => {
    expect(await lookupCompanySignIn(`anyone@${a.domain}`)).toEqual({ sso: true, startUrl: `/api/sso/saml/${a.connectionId}/start`, required: false });
    expect(await lookupCompanySignIn("someone@unknown-company.example")).toEqual({ sso: false });
  });

  it("signs a user from the test provider in to the right business", async () => {
    const result = await signIn(a, nurseA.email, { name: "Nurse Nandini" });
    expect(result.path).toMatch(/^\/api\/auth\/sso\/complete\?ticket=/);
    const ticket = await redeemSsoTicket(decodeURIComponent(result.path.split("ticket=")[1]!));
    expect(ticket).toEqual({ userId: nurseA.userId, tenantId: a.tenant.tenantId, connectionId: a.connectionId, binding: result.binding });
    // The ticket works once.
    expect(await redeemSsoTicket(decodeURIComponent(result.path.split("ticket=")[1]!))).toBeNull();
  });

  it("refuses a replay of the same reply, an unsigned one, one signed by someone else, the wrong audience and an expired one", async () => {
    const first = await signIn(a, nurseA.email);
    expect(first.path).toContain("/api/auth/sso/complete");
    expect((await signIn(a, nurseA.email, {}, { response: first.response })).path).toBe("/sign-in?error=sso_invalid_response");
    expect((await signIn(a, nurseA.email, { sign: false })).path).toBe("/sign-in?error=sso_invalid_response");
    expect((await signIn(a, nurseA.email, { signWith: createTestIdp("https://evil.example/") })).path).toBe("/sign-in?error=sso_invalid_response");
    expect((await signIn(a, nurseA.email, { audienceOverride: "https://someone-else.example/" })).path).toBe("/sign-in?error=sso_invalid_response");
    expect((await signIn(a, nurseA.email, { expired: true })).path).toBe("/sign-in?error=sso_invalid_response");
    // A reply that was never asked for (no request id we made) is refused too.
    const urls = serviceProviderUrls(appOrigin(), a.connectionId);
    const unasked = buildSamlResponse({ idp: a.idp, audience: urls.entityId, acsUrl: urls.acsUrl, inResponseTo: "_never_asked", email: nurseA.email });
    expect(await finishSamlSignIn(a.connectionId, { SAMLResponse: unasked })).toBe("/sign-in?error=sso_invalid_response");
  });

  it("never lets one business's provider sign someone into another business", async () => {
    // B's provider asserts an address on A's domain: refused, because B's connection only speaks for B's domain.
    expect((await signIn(b, nurseA.email)).path).toBe("/sign-in?error=sso_wrong_domain");
    // A's connection id with B's provider's signature: refused.
    expect((await signIn(a, nurseA.email, { signWith: b.idp })).path).toBe("/sign-in?error=sso_invalid_response");
    // And an address on its own domain that belongs to nobody there is not let in unless auto-join is on.
    expect((await signIn(b, `stranger@${b.domain}`)).path).toBe("/sign-in?error=sso_not_invited");
    const tickets = await owner`select count(*)::int as n from memberships where tenant_id = ${b.tenant.tenantId} and user_id = ${nurseA.userId}`;
    expect(tickets[0]!.n).toBe(0);
  });

  it("lets a new person join only when auto-join is on, with the role the owner chose, and keeps a removed person out", async () => {
    const context = staffContext(a.tenant, { membershipId: a.owner.membershipId, userId: a.owner.userId });
    expect((await signIn(a, `new.joiner@${a.domain}`)).path).toBe("/sign-in?error=sso_not_invited");
    const [fresh] = await owner<{ version: number }[]>`select version from verified_domains where id = ${a.domainId}`;
    const domain = await updateDomain(context, a.domainId, { autoJoinEnabled: true, autoJoinRole: "receptionist", version: fresh!.version });
    const joined = await signIn(a, `new.joiner@${a.domain}`, { name: "New Joiner" });
    expect(joined.path).toContain("/api/auth/sso/complete");
    const [membership] = await owner`select role, is_active from memberships m join auth_users u on u.id = m.user_id where m.tenant_id = ${a.tenant.tenantId} and u.email = ${`new.joiner@${a.domain}`}`;
    expect(membership).toMatchObject({ role: "receptionist", is_active: true });
    await owner`update memberships set is_active = false where id = ${nurseA.membershipId}`;
    expect((await signIn(a, nurseA.email)).path).toBe("/sign-in?error=sso_access_removed");
    await owner`update memberships set is_active = true where id = ${nurseA.membershipId}`;
    await updateDomain(context, a.domainId, { autoJoinEnabled: false, version: domain.version });
  });

  it("records every refusal in that business's audit trail, without the email address", async () => {
    const rows = await owner`select metadata::text as metadata, outcome from audit_events where tenant_id = ${a.tenant.tenantId} and action = 'staff.sso.sign_in.failed'`;
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.every((row) => row.outcome === "failed" && !String(row.metadata).includes("@"))).toBe(true);
    const others = await owner`select count(*)::int as n from audit_events where tenant_id = ${b.tenant.tenantId} and action = 'staff.sso.sign_in.failed' and metadata::text like ${`%${nurseA.userId}%`}`;
    expect(others[0]!.n).toBe(0);
  });

  it("will not require company sign-in until there is a break-glass owner with a second factor, then makes others use it", async () => {
    const context = staffContext(a.tenant, { membershipId: a.owner.membershipId, userId: a.owner.userId });
    const [current] = await owner<{ version: number }[]>`select version from verified_domains where id = ${a.domainId}`;
    expect((await failure(updateDomain(context, a.domainId, { requireSso: true, version: current!.version }))).code).toBe("break_glass_required");
    // The break-glass owner needs an authenticator app or a passkey first.
    expect((await failure(setBreakGlassOwner(context, a.owner.membershipId))).code).toBe("second_factor_required");
    await owner`update auth_users set two_factor_enabled = true where id = ${a.owner.userId}`;
    await setBreakGlassOwner(context, a.owner.membershipId);
    const required = await updateDomain(context, a.domainId, { requireSso: true, version: current!.version });
    expect(required.requireSso).toBe(true);
    expect(await companySignInRequiredFor(nurseA.userId)).toBe(true);
    expect(await companySignInRequiredFor(a.owner.userId)).toBe(false);
    // The connection can't be switched off or removed while it is required.
    expect((await failure(setSsoStatus(context, a.domainId, "disabled"))).code).toBe("sso_required");
    expect((await failure(removeSsoConnection(context, a.domainId))).code).toBe("sso_required");
    await updateDomain(context, a.domainId, { requireSso: false, version: required.version });
    expect(await companySignInRequiredFor(nurseA.userId)).toBe(false);
  });

  it("needs a recent second-factor check and the plan feature to change any of it", async () => {
    const stale = staffContext(a.tenant, { secondFactorAt: new Date(Date.now() - 60 * 60_000) });
    expect((await failure(addDomain(stale, { domain: "another-company.example" }))).code).toBe("step_up_required");
    const starter = staffContext(a.tenant, { entitlements: { planKey: "growth", planName: "Growth", status: "active", limits: { staffCalendars: 10, locations: 3, bookingsPerMonth: null, messagesIncluded: { whatsapp: 0, sms: 0 }, features: { onlinePayments: true, customDomain: true, removeBadge: true, calendarSync: "full", reports: true, api: true, assistant: true, enterprise: false } }, trialEndsAt: null, graceEndsAt: null, currentPeriodEnd: null } });
    expect((await failure(addDomain(starter, { domain: "another-company.example" }))).status).toBe(402);
    expect((await failure(addDomain(staffContext(a.tenant), { domain: "gmail.com" }))).code).toBe("shared_mail_domain");
  });

  it("keeps connections and domains out of another business's reach", async () => {
    const contextB = staffContext(b.tenant, { membershipId: b.owner.membershipId, userId: b.owner.userId });
    expect((await failure(updateDomain(contextB, a.domainId, { autoJoinEnabled: true, version: 1 }))).code).toBe("domain_not_found");
    expect((await failure(setSsoStatus(contextB, a.domainId, "disabled"))).code).toBe("domain_not_found");
    // The same domain cannot be proved twice: the second business's claim is refused by the database.
    await addDomain(contextB, { domain: a.domain });
    await expect(owner`update verified_domains set verified_at = now() where tenant_id = ${b.tenant.tenantId} and domain = ${a.domain}`).rejects.toThrow();
  });
});
