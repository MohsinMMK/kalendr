/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { isolatedDatabaseReady } from "@/test/isolated-database";

vi.mock("server-only", () => ({}));

import { GET as listUsersRoute, POST as createUserRoute } from "@/app/api/scim/v2/Users/route";
import { DELETE as deleteUserRoute, GET as getUserRoute, PATCH as patchUserRoute } from "@/app/api/scim/v2/Users/[id]/route";
import { GET as listGroupsRoute, POST as createGroupRoute } from "@/app/api/scim/v2/Groups/route";
import { PATCH as patchGroupRoute } from "@/app/api/scim/v2/Groups/[id]/route";
import { auth } from "@/lib/auth";
import { addMember, type MemberFixture } from "@/test/enterprise-fixture";
import { setSubscription } from "@/test/billing-fixture";
import { createBooking, createCustomer, createTenant, staffContext, type TenantFixture } from "@/test/privacy-fixture";
import { addDomain } from "@/server/enterprise/domains";
import { listReassignmentsNeeded } from "@/server/enterprise/reassign";
import { createScimToken, revokeScimToken } from "@/server/enterprise/scim-tokens";

const describeLocal = isolatedDatabaseReady(process.env.DATABASE_URL, process.env.KALENDR_TEST_OWNER_URL) ? describe : describe.skip;

interface Business { tenant: TenantFixture; owner: MemberFixture; domain: string; token: string; tokenId: string }

describeLocal("directory sync (SCIM)", () => {
  let owner: postgres.Sql;
  let a: Business;
  let b: Business;

  async function business(label: string): Promise<Business> {
    const tenant = await createTenant(owner, label);
    await setSubscription(owner, tenant.tenantId, { plan: "scale", status: "active" });
    const ownerMember = await addMember(owner, tenant.tenantId, "owner");
    const context = staffContext(tenant, { membershipId: ownerMember.membershipId, userId: ownerMember.userId });
    const domain = `${label}-${randomUUID().slice(0, 8)}.example`;
    const added = await addDomain(context, { domain });
    await owner`update verified_domains set verified_at = now() where id = ${added.id}`;
    const created = await createScimToken(context, { name: "Okta", defaultRole: "receptionist" });
    return { tenant, owner: ownerMember, domain, token: created.token!, tokenId: created.id };
  }

  const call = (token: string | null, url: string, init: { method?: string; body?: unknown } = {}) => new Request(`http://localhost:3000/api/scim/v2${url}`, {
    method: init.method ?? "GET",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/scim+json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const newUser = (business: Business, local: string, extra: Record<string, unknown> = {}) => ({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: `${local}@${business.domain}`, externalId: `ext-${local}`, name: { givenName: "Anita", familyName: "Rao" }, active: true, ...extra,
  });

  beforeAll(async () => {
    owner = postgres(process.env.KALENDR_TEST_OWNER_URL!, { max: 2, prepare: false });
    a = await business("scima");
    b = await business("scimb");
  });

  afterAll(async () => {
    await owner`delete from tenants where id in (${a.tenant.tenantId}, ${b.tenant.tenantId})`.catch(() => undefined);
    await owner.end();
  });

  it("refuses a missing, wrong or revoked token", async () => {
    expect((await listUsersRoute(call(null, "/Users"))).status).toBe(401);
    expect((await listUsersRoute(call(`kscim_${"x".repeat(43)}`, "/Users"))).status).toBe(401);
    const context = staffContext(a.tenant, { membershipId: a.owner.membershipId, userId: a.owner.userId });
    const spare = await createScimToken(context, { name: "Spare", defaultRole: "read_only" });
    expect((await listUsersRoute(call(spare.token!, "/Users"))).status).toBe(200);
    await revokeScimToken(context, spare.id);
    expect((await listUsersRoute(call(spare.token!, "/Users"))).status).toBe(401);
    const stored = await owner`select token_hash from scim_tokens where id = ${spare.id}`;
    expect(stored[0]!.token_hash).not.toContain(spare.token!);
  });

  it("creates, reads and finds a person, only for addresses on a proved domain", async () => {
    const created = await createUserRoute(call(a.token, "/Users", { method: "POST", body: newUser(a, "anita") }));
    expect(created.status).toBe(201);
    const user = await created.json();
    expect(user).toMatchObject({ userName: `anita@${a.domain}`, active: true, externalId: "ext-anita" });
    const [row] = await owner`select role from memberships where id = ${user.id}`;
    expect(row!.role).toBe("receptionist");
    const duplicate = await createUserRoute(call(a.token, "/Users", { method: "POST", body: newUser(a, "anita") }));
    expect(duplicate.status).toBe(409);
    const outside = await createUserRoute(call(a.token, "/Users", { method: "POST", body: newUser(a, "x", { userName: "someone@elsewhere.example" }) }));
    expect(outside.status).toBe(400);
    const found = await (await listUsersRoute(call(a.token, `/Users?filter=${encodeURIComponent(`userName eq "anita@${a.domain}"`)}`))).json();
    expect(found.totalResults).toBe(1);
    const odd = await listUsersRoute(call(a.token, `/Users?filter=${encodeURIComponent('emails.value co "x"')}`));
    expect(odd.status).toBe(400);
  });

  it("deactivates within a request: no sign-in, sessions ended, bookings listed for reassignment, nothing deleted", async () => {
    const created = await (await createUserRoute(call(a.token, "/Users", { method: "POST", body: newUser(a, "dr.mehta", { externalId: "ext-mehta" }) }))).json();
    const [membership] = await owner<{ user_id: string }[]>`select user_id from memberships where id = ${created.id}`;
    // Mehta sees patients: their profile is the business's doctor, with two bookings ahead.
    await owner`update practitioners set auth_user_id = ${membership!.user_id} where id = ${a.tenant.practitionerId}`;
    const customer = await createCustomer(owner, a.tenant.tenantId);
    const first = await createBooking(owner, a.tenant, customer.id, { status: "booked", endsDaysAgo: -2 });
    await createBooking(owner, a.tenant, customer.id, { status: "booked", endsDaysAgo: -3 });
    const sessions = await auth.$context;
    const session = await sessions.internalAdapter.createSession(membership!.user_id);
    expect((await owner`select 1 from kalendr_resolve_staff_access(${membership!.user_id})`).length).toBe(1);

    // Okta sends the change as a value object; Azure AD sends a path and the word "False".
    const response = await patchUserRoute(call(a.token, `/Users/${created.id}`, { method: "PATCH", body: { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "Replace", value: { active: false } }] } }), params(created.id));
    expect(response.status).toBe(200);
    expect((await response.json()).active).toBe(false);

    expect((await owner`select 1 from kalendr_resolve_staff_access(${membership!.user_id})`).length).toBe(0);
    expect(await sessions.internalAdapter.findSession(session!.token)).toBeNull();
    const [appointment] = await owner`select status from appointments where id = ${first}`;
    expect(appointment!.status).toBe("booked");
    const needed = await listReassignmentsNeeded(staffContext(a.tenant));
    expect(needed).toHaveLength(1);
    expect(needed[0]).toMatchObject({ practitionerId: a.tenant.practitionerId, bookings: 2 });
    const [event] = await owner`select metadata from audit_events where tenant_id = ${a.tenant.tenantId} and action = 'enterprise.scim.user_deactivated'`;
    expect(event!.metadata).toMatchObject({ futureBookings: 2 });
    expect(JSON.stringify(event!.metadata)).not.toContain(a.domain);

    const azure = await patchUserRoute(call(a.token, `/Users/${created.id}`, { method: "PATCH", body: { Operations: [{ op: "Replace", path: "active", value: "True" }] } }), params(created.id));
    expect((await azure.json()).active).toBe(true);
    expect(await listReassignmentsNeeded(staffContext(a.tenant))).toHaveLength(0);
    const gone = await deleteUserRoute(call(a.token, `/Users/${created.id}`, { method: "DELETE" }), params(created.id));
    expect(gone.status).toBe(204);
    expect((await owner`select is_active from memberships where id = ${created.id}`)[0]!.is_active).toBe(false);
    expect((await owner`select count(*)::int as n from appointments where tenant_id = ${a.tenant.tenantId}`)[0]!.n).toBeGreaterThanOrEqual(2);
  });

  it("never changes the owner, and never reaches another business's people", async () => {
    const attempt = await patchUserRoute(call(a.token, `/Users/${a.owner.membershipId}`, { method: "PATCH", body: { Operations: [{ op: "replace", path: "active", value: false }] } }), params(a.owner.membershipId));
    expect(attempt.status).toBe(403);
    expect((await owner`select is_active from memberships where id = ${a.owner.membershipId}`)[0]!.is_active).toBe(true);
    const bPerson = await (await createUserRoute(call(b.token, "/Users", { method: "POST", body: newUser(b, "bella") }))).json();
    expect((await getUserRoute(call(a.token, `/Users/${bPerson.id}`), params(bPerson.id))).status).toBe(404);
    expect((await patchUserRoute(call(a.token, `/Users/${bPerson.id}`, { method: "PATCH", body: { Operations: [{ op: "replace", path: "active", value: false }] } }), params(bPerson.id))).status).toBe(404);
    expect((await deleteUserRoute(call(a.token, `/Users/${bPerson.id}`, { method: "DELETE" }), params(bPerson.id))).status).toBe(404);
    expect((await owner`select is_active from memberships where id = ${bPerson.id}`)[0]!.is_active).toBe(true);
    const listed = await (await listUsersRoute(call(a.token, "/Users"))).json();
    expect(JSON.stringify(listed)).not.toContain(b.domain);
  });

  it("refuses a directory whose plan has no enterprise features", async () => {
    await setSubscription(owner, a.tenant.tenantId, { plan: "growth", status: "active" });
    expect((await listUsersRoute(call(a.token, "/Users"))).status).toBe(403);
    await setSubscription(owner, a.tenant.tenantId, { plan: "scale", status: "active" });
    expect((await listUsersRoute(call(a.token, "/Users"))).status).toBe(200);
  });

  it("maps groups to teams, and only puts this business's people in them", async () => {
    const person = await (await createUserRoute(call(a.token, "/Users", { method: "POST", body: newUser(a, "gita") }))).json();
    const group = await (await createGroupRoute(call(a.token, "/Groups", { method: "POST", body: { displayName: "Dermatology", members: [{ value: person.id }] } }))).json();
    expect(group.members).toHaveLength(1);
    const [team] = await owner`select name, is_private from teams where id = ${group.id}`;
    expect(team).toMatchObject({ name: "Dermatology", is_private: false });
    const foreign = await createGroupRoute(call(a.token, "/Groups", { method: "POST", body: { displayName: "Sneaky", members: [{ value: a.owner.membershipId }, { value: randomUUID() }] } }));
    expect(foreign.status).toBe(400);
    const removed = await (await patchGroupRoute(call(a.token, `/Groups/${group.id}`, { method: "PATCH", body: { Operations: [{ op: "remove", path: `members[value eq "${person.id}"]` }] } }), params(group.id))).json();
    expect(removed.members).toHaveLength(0);
    const added = await (await patchGroupRoute(call(a.token, `/Groups/${group.id}`, { method: "PATCH", body: { Operations: [{ op: "add", path: "members", value: [{ value: person.id }] }] } }), params(group.id))).json();
    expect(added.members).toHaveLength(1);
    const listed = await (await listGroupsRoute(call(b.token, "/Groups"))).json();
    expect(listed.totalResults).toBe(0);
  });
});
