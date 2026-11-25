/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { isolatedDatabaseReady } from "@/test/isolated-database";

vi.mock("server-only", () => ({}));

import { auth } from "@/lib/auth";
import { addMember, type MemberFixture } from "@/test/enterprise-fixture";
import { createTenant, type TenantFixture } from "@/test/privacy-fixture";
import { issueSsoTicket, newBrowserBinding, SSO_BROWSER_COOKIE } from "./sso-state";
import { totp } from "../../../e2e/support/second-factor";

const describeLocal = isolatedDatabaseReady(process.env.DATABASE_URL, process.env.KALENDR_TEST_OWNER_URL) ? describe : describe.skip;

/** A ticket bound to a fresh browser cookie, and the request that redeems it from that browser (or from another). */
async function boundTicket(userId: string, tenantId: string, connectionId: string) {
  const browser = newBrowserBinding();
  const ticket = await issueSsoTicket({ userId, tenantId, connectionId, binding: browser.binding });
  const open = (cookie: string | null = browser.cookie) => new Request(`http://localhost:3000/api/auth/sso/complete?ticket=${encodeURIComponent(ticket)}`,
    cookie ? { headers: { cookie: `${SSO_BROWSER_COOKIE}=${cookie}` } } : {});
  return { ticket, open };
}

describeLocal("company sign-in makes a real session, and required company sign-in shuts the other doors", () => {
  let owner: postgres.Sql;
  let tenant: TenantFixture;
  let domain = "";
  let breakGlass: MemberFixture;
  let nurse: MemberFixture;
  let connectionId = "";

  beforeAll(async () => {
    owner = postgres(process.env.KALENDR_TEST_OWNER_URL!, { max: 2, prepare: false });
    tenant = await createTenant(owner, "ssosess");
    domain = `sess-${randomUUID().slice(0, 8)}.example`;
    breakGlass = await addMember(owner, tenant.tenantId, "owner", { email: `owner@${domain}` });
    nurse = await addMember(owner, tenant.tenantId, "receptionist", { email: `nurse@${domain}` });
    const [row] = await owner<{ id: string }[]>`insert into verified_domains (tenant_id, domain, token_hash, verified_at, require_sso) values (${tenant.tenantId}, ${domain}, 'x', now(), true) returning id`;
    const [connection] = await owner<{ id: string }[]>`insert into sso_connections (tenant_id, domain_id, kind, status, idp_entity_id, idp_sso_url, idp_certificate) values (${tenant.tenantId}, ${row!.id}, 'saml', 'active', 'e', 'https://x.example/', 'c') returning id`;
    connectionId = connection!.id;
    await owner`update memberships set break_glass = true where id = ${breakGlass.membershipId}`;
  });

  afterAll(async () => {
    await owner`delete from tenants where id = ${tenant.tenantId}`.catch(() => undefined);
    await owner.end();
  });

  it("trades a ticket for a session cookie and sends the person to their workspace, once", async () => {
    const { open } = await boundTicket(nurse.userId, tenant.tenantId, connectionId);
    const first = await auth.handler(open());
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toContain("/dashboard");
    expect(first.headers.get("set-cookie")).toContain("kalendr.session_token");
    const again = await auth.handler(open());
    expect(again.headers.get("location")).toContain("/sign-in?error=sso_invalid_response");
    expect(again.headers.get("set-cookie") ?? "").not.toContain("session_token=");
    const [event] = await owner`select outcome from audit_events where tenant_id = ${tenant.tenantId} and actor_user_id = ${nurse.userId} and action = 'staff.sso.sign_in'`;
    expect(event?.outcome).toBe("success");
  });

  it("only finishes a sign-in in the browser that started it", async () => {
    // Someone else's ticket opened in a browser with no sign-in of its own, or a different one: refused, and the ticket is spent.
    const stranger = await boundTicket(nurse.userId, tenant.tenantId, connectionId);
    const noCookie = await auth.handler(stranger.open(null));
    expect(noCookie.headers.get("location")).toContain("/sign-in?error=sso_invalid_response");
    expect(noCookie.headers.get("set-cookie") ?? "").not.toContain("session_token=");
    const other = await boundTicket(nurse.userId, tenant.tenantId, connectionId);
    const wrong = await auth.handler(other.open(newBrowserBinding().cookie));
    expect(wrong.headers.get("location")).toContain("/sign-in?error=sso_invalid_response");
    expect(wrong.headers.get("set-cookie") ?? "").not.toContain("session_token=");
    expect((await auth.handler(other.open())).headers.get("location")).toContain("sso_invalid_response");
    // A ticket with no binding at all (a provider-started SAML reply) never redeems.
    const unbound = await issueSsoTicket({ userId: nurse.userId, tenantId: tenant.tenantId, connectionId, binding: "" });
    const response = await auth.handler(new Request(`http://localhost:3000/api/auth/sso/complete?ticket=${encodeURIComponent(unbound)}`, { headers: { cookie: `${SSO_BROWSER_COOKIE}=x` } }));
    expect(response.headers.get("location")).toContain("sso_invalid_response");
  });

  it("refuses any other way of signing in for people on a required domain, but not the break-glass owner", async () => {
    const context = await auth.$context;
    await expect(context.internalAdapter.createSession(nurse.userId)).rejects.toThrow();
    const session = await context.internalAdapter.createSession(breakGlass.userId);
    expect(session?.userId).toBe(breakGlass.userId);
    const refused = await owner`select outcome from audit_events where tenant_id = ${tenant.tenantId} and action = 'staff.sign_in.refused'`;
    expect(refused.length).toBeGreaterThan(0);
  });

  it("stops a ticket made for a person who has since lost their membership", async () => {
    await owner`update memberships set is_active = false where id = ${nurse.membershipId}`;
    const { open } = await boundTicket(nurse.userId, tenant.tenantId, connectionId);
    const response = await auth.handler(open());
    expect(response.headers.get("location")).toContain("sso_not_invited");
  });

  it("lets an admin on a required domain enrol an authenticator app without being signed out", async () => {
    const admin = await addMember(owner, tenant.tenantId, "admin", { email: `admin@${domain}` });
    // No password yet, so Better Auth does not ask for one when the app is added.
    await owner`update auth_users set password_set_at = null where id = ${admin.userId}`;
    const { open } = await boundTicket(admin.userId, tenant.tenantId, connectionId);
    const signedIn = await auth.handler(open());
    const cookie = (signedIn.headers.getSetCookie?.() ?? []).map((line) => line.split(";")[0]).filter((pair) => pair?.includes("session_token")).join("; ");
    expect(cookie).toContain("kalendr.session_token");
    const post = (path: string, body: unknown) => auth.handler(new Request(`http://localhost:3000/api/auth/${path}`, {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000", cookie }, body: JSON.stringify(body),
    }));
    const enabled = await post("two-factor/enable", {});
    expect(enabled.status).toBe(200);
    const { totpURI } = await enabled.json() as { totpURI: string };
    const secret = new URL(totpURI).searchParams.get("secret")!;
    // The first correct code turns the second factor on and swaps the session for a fresh one: the step the guard must let through.
    const verified = await post("two-factor/verify-totp", { code: totp(secret) });
    expect(verified.status).toBe(200);
    expect(verified.headers.get("set-cookie")).toContain("kalendr.session_token");
    const [after] = await owner`select two_factor_enabled from auth_users where id = ${admin.userId}`;
    expect(after!.two_factor_enabled).toBe(true);
  });
});
