/** @vitest-environment node */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }));

import { POST as changePlan } from "@/app/api/admin/tenants/[id]/change-plan/route";
import { POST as extendTrial } from "@/app/api/admin/tenants/[id]/extend-trial/route";
import { GET as getTenant } from "@/app/api/admin/tenants/[id]/route";
import { GET as listTenantsRoute } from "@/app/api/admin/tenants/route";
import { impersonationCookieName } from "@/lib/admin-contracts";
import { getStaffContext } from "../staff-context";
import { startImpersonation, endImpersonation } from "./impersonation";
import { Fixture, localDatabaseReady, type Person, type SignedIn } from "./test-fixture";

const describeLocal = localDatabaseReady ? describe : describe.skip;

function post(session: SignedIn, tenantId: string, body: unknown) {
  const request = new Request(`http://localhost:3000/api/admin/tenants/${tenantId}/x`, {
    method: "POST", headers: { ...Object.fromEntries(session.headers), "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { request, context: { params: Promise.resolve({ id: tenantId }) } };
}
const get = (session: SignedIn, path: string) => new Request(`http://localhost:3000${path}`, { headers: session.headers });

describeLocal("admin billing routes", () => {
  const fixture = new Fixture();
  let tenant = { id: "", slug: "" };
  let support: Person; let billing: Person; let superUser: Person;
  let supportSession: SignedIn; let billingSession: SignedIn; let staleBilling: SignedIn; let superSession: SignedIn;

  beforeAll(async () => {
    tenant = await fixture.tenant("bill");
    support = await fixture.person("bsup"); billing = await fixture.person("bbil"); superUser = await fixture.person("bsu");
    await fixture.makeOperator(support, "support"); await fixture.makeOperator(billing, "billing"); await fixture.makeOperator(superUser, "super");
    supportSession = await fixture.signInWithSecondFactor(support);
    billingSession = await fixture.signInWithSecondFactor(billing);
    const staleOperator = await fixture.person("bstale");
    await fixture.makeOperator(staleOperator, "billing");
    staleBilling = await fixture.signInWithSecondFactor(staleOperator, 2);
    superSession = await fixture.signInWithSecondFactor(superUser);
  });
  afterAll(async () => { await fixture.end(); });

  it("refuses support, needs a reason, and needs a fresh second factor", async () => {
    let call = post(supportSession, tenant.id, { days: 3, reason: "Owner asked for more time" });
    expect((await extendTrial(call.request, call.context)).status).toBe(403);
    call = post(billingSession, tenant.id, { days: 3, reason: "no" });
    expect((await extendTrial(call.request, call.context)).status).toBe(400);
    call = post(billingSession, tenant.id, { days: 61, reason: "Owner asked for more time" });
    expect((await extendTrial(call.request, call.context)).status).toBe(400);
    call = post(staleBilling, tenant.id, { days: 3, reason: "Owner asked for more time" });
    expect((await extendTrial(call.request, call.context)).status).toBe(403);
    call = post(supportSession, tenant.id, { planKey: "scale", reason: "Paid by bank transfer" });
    expect((await changePlan(call.request, call.context)).status).toBe(403);
    call = post(billingSession, tenant.id, { planKey: "platinum", reason: "Paid by bank transfer" });
    expect((await changePlan(call.request, call.context)).status).toBe(400);
  });

  it("extends a trial and changes a plan, audited, and the list and detail show the plan", async () => {
    const [before] = await fixture.owner<{ ends: Date }[]>`select trial_ends_at as ends from tenant_subscriptions where tenant_id = ${tenant.id}`;
    let call = post(billingSession, tenant.id, { days: 5, reason: "Owner lost a week to an outage" });
    let response = await extendTrial(call.request, call.context);
    expect(response.status).toBe(200);
    const [after] = await fixture.owner<{ ends: Date }[]>`select trial_ends_at as ends from tenant_subscriptions where tenant_id = ${tenant.id}`;
    expect(after!.ends.getTime()).toBeGreaterThan(before!.ends.getTime());

    call = post(superSession, tenant.id, { planKey: "scale", reason: "Paid by bank transfer, invoice 1042" });
    response = await changePlan(call.request, call.context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { planKey: "scale" } });
    const audit = await fixture.owner<{ action: string }[]>`select action from platform_audit_events where tenant_id = ${tenant.id} and action like 'admin.%' and action ~ 'trial|plan'`;
    expect(audit.length).toBeGreaterThanOrEqual(2);

    const detail = await (await getTenant(get(supportSession, `/api/admin/tenants/${tenant.id}`), { params: Promise.resolve({ id: tenant.id }) })).json();
    expect(detail.data.billing).toMatchObject({ planKey: "scale" });
    const list = await (await listTenantsRoute(get(supportSession, `/api/admin/tenants?search=${tenant.slug}`))).json();
    expect(list.data.items.find((row: { tenantId: string }) => row.tenantId === tenant.id)).toMatchObject({ planKey: "scale" });
  });

  it("a write-access support session carries the business's plan entitlements", async () => {
    const started = await startImpersonation(superUser.id, tenant.id, "Checking plan limits for the owner", true);
    const headers = new Headers(superSession.headers);
    headers.set("cookie", `${headers.get("cookie") ?? ""}; ${impersonationCookieName}=${started.token}`);
    const context = await getStaffContext(headers);
    expect(context.impersonation?.writeAccess).toBe(true);
    // The business is still on its trial, which gives Growth whatever plan is stored; what matters is that limits are loaded.
    expect(context.entitlements).toMatchObject({ planKey: "growth", limits: expect.any(Object) });
    await endImpersonation(superUser.id, started.sessionId);
  });
});
