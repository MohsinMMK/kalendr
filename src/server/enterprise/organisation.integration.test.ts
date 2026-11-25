/** @vitest-environment node */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { withTenant } from "@/db/client";
import { isolatedDatabaseReady } from "@/test/isolated-database";

vi.mock("server-only", () => ({}));

import { addMember, contextForMember, type MemberFixture } from "@/test/enterprise-fixture";
import { createTenant, staffContext, type TenantFixture } from "@/test/privacy-fixture";
import { ApiError } from "@/server/api-error";
import { getVisitPayments } from "@/server/payments";
import { updateStaffMember } from "@/server/staff-team";
import { saveOrgDefaults, getOrgDefaults } from "./defaults";
import { createAttribute, listPersonAttributes, setPersonAttributes } from "./attributes";
import { createCustomRole, deleteCustomRole, listCustomRoles, updateCustomRole } from "./roles";
import { createTeam, deleteTeam, listTeams, loadPublicTeam, updateTeam } from "./teams";
import { listActivity } from "@/server/staff-activity";

const describeLocal = isolatedDatabaseReady(process.env.DATABASE_URL, process.env.KALENDR_TEST_OWNER_URL) ? describe : describe.skip;

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try { await promise; } catch (error: unknown) { if (error instanceof ApiError) return error; throw error; }
  throw new Error("Expected the call to be refused.");
}

describeLocal("organisation: teams, custom roles, attributes, defaults and the audit viewer", () => {
  let owner: postgres.Sql;
  let a: TenantFixture;
  let b: TenantFixture;
  let ownerA: MemberFixture;
  let frontDesk: MemberFixture;

  beforeAll(async () => {
    owner = postgres(process.env.KALENDR_TEST_OWNER_URL!, { max: 2, prepare: false });
    a = await createTenant(owner, "orga");
    b = await createTenant(owner, "orgb");
    ownerA = await addMember(owner, a.tenantId, "owner");
    frontDesk = await addMember(owner, a.tenantId, "receptionist");
  });

  afterAll(async () => {
    await owner`delete from tenants where id in (${a.tenantId}, ${b.tenantId})`.catch(() => undefined);
    await owner.end();
  });

  it("a custom Front desk role can book but gets 403 on payments", async () => {
    const context = staffContext(a, { membershipId: ownerA.membershipId, userId: ownerA.userId });
    const role = await createCustomRole(context, {
      name: "Front desk", baseRole: "receptionist",
      permissions: ["appointments.book", "appointments.status", "waitlist.manage", "profile.own"],
    });
    await updateStaffMember(context, frontDesk.membershipId, { customRoleId: role.id });
    const member = await contextForMember(a, frontDesk);
    expect(member.role).toBe("receptionist");
    expect(member.permissions).toContain("appointments.book");
    expect(member.permissions).not.toContain("payments.collect");
    const refused = await failure(getVisitPayments(member, "00000000-0000-0000-0000-000000000000"));
    expect(refused.status).toBe(403);
    expect(refused.code).toBe("forbidden");
    // The built-in Receptionist preset can take payments; the custom role replaced it.
    expect(role.permissions).not.toContain("payments.collect");
  });

  it("editing the role changes what its holders may do on their next request", async () => {
    const context = staffContext(a, { membershipId: ownerA.membershipId, userId: ownerA.userId });
    const [role] = await listCustomRoles(context);
    expect(role!.memberCount).toBe(1);
    await updateCustomRole(context, role!.id, { version: role!.version, permissions: [...role!.permissions, "payments.collect"] });
    expect((await contextForMember(a, frontDesk)).permissions).toContain("payments.collect");
    await failure(updateCustomRole(context, role!.id, { version: role!.version, name: "Stale" })).then((error) => expect(error.code).toBe("version_conflict"));
  });

  it("refuses a role in use being deleted, and permissions the author does not hold", async () => {
    const context = staffContext(a, { membershipId: ownerA.membershipId, userId: ownerA.userId });
    const [role] = await listCustomRoles(context);
    expect((await failure(deleteCustomRole(context, role!.id))).code).toBe("role_in_use");
    const limited = staffContext(a, { role: "admin", permissions: ["org.manage", "appointments.book"] });
    expect((await failure(createCustomRole(limited, { name: "Too much", baseRole: "read_only", permissions: ["payments.refund"] }))).code).toBe("cannot_grant");
  });

  it("needs the org.manage permission and a recent second-factor check", async () => {
    const plain = await contextForMember(a, frontDesk);
    expect((await failure(createCustomRole({ ...plain, permissions: ["appointments.book"] }, { name: "X", baseRole: "read_only", permissions: [] }))).status).toBe(403);
    const stale = staffContext(a, { secondFactorAt: new Date(Date.now() - 60 * 60_000) });
    expect((await failure(createCustomRole(stale, { name: "Y", baseRole: "read_only", permissions: [] }))).code).toBe("step_up_required");
  });

  it("makes nested teams, and a private team's page lists nobody", async () => {
    const context = staffContext(a, { membershipId: ownerA.membershipId, userId: ownerA.userId });
    const doctor = await addMember(owner, a.tenantId, "practitioner");
    await owner`insert into practitioners (tenant_id, name, title, initials, specialty, auth_user_id) values (${a.tenantId}, 'Dr Skin', 'Doctor', 'DS', 'Dermatology', ${doctor.userId})`;
    const parent = await createTeam(context, { name: "Dermatology", description: "Skin and hair", membershipIds: [doctor.membershipId] });
    expect(parent.slug).toBe("dermatology");
    const child = await createTeam(context, { name: "Cosmetic dermatology", parentTeamId: parent.id, isPrivate: true, membershipIds: [doctor.membershipId] });
    const page = await loadPublicTeam(a.tenantId, "dermatology");
    expect(page?.children.map((entry) => entry.slug)).toEqual([child.slug]);
    expect(page?.practitionerIds).toHaveLength(1);
    const privatePage = await loadPublicTeam(a.tenantId, child.slug);
    expect(privatePage?.isPrivate).toBe(true);
    expect(privatePage?.practitionerIds).toEqual([]);
    expect(privatePage?.parent?.slug).toBe("dermatology");
    // A team can't sit under its own sub-team, and a team with sub-teams can't be deleted.
    expect((await failure(updateTeam(context, parent.id, { version: parent.version, parentTeamId: child.id }))).code).toBe("team_loop");
    expect((await failure(deleteTeam(context, parent.id))).code).toBe("team_has_children");
    await deleteTeam(context, child.id);
    expect((await listTeams(context)).map((team) => team.slug)).toEqual(["dermatology"]);
  });

  it("keeps one business's teams, roles and pages out of another's", async () => {
    const contextB = staffContext(b, { membershipId: null });
    expect(await listTeams(contextB)).toEqual([]);
    expect(await listCustomRoles(contextB)).toEqual([]);
    expect(await loadPublicTeam(b.tenantId, "dermatology")).toBeNull();
    // Even asking for A's rows by id from B's scope finds nothing, whatever the application code does.
    const [role] = await listCustomRoles(staffContext(a));
    const leaked = await withTenant(b.tenantId, (transaction) => transaction.execute(`select id from custom_roles where id = '${role!.id}'` as never));
    expect(leaked).toHaveLength(0);
    expect((await failure(updateCustomRole(contextB, role!.id, { version: 1, name: "Taken over" }))).code).toBe("custom_role_not_found");
  });

  it("will not remove a business's last active owner, whatever asks", async () => {
    await expect(owner`update memberships set role = 'admin' where id = ${ownerA.membershipId}`).rejects.toMatchObject({ constraint_name: "memberships_keep_one_owner" });
    await expect(owner`update memberships set is_active = false where id = ${ownerA.membershipId}`).rejects.toThrow(/at least one active owner/);
    await expect(owner`delete from memberships where id = ${ownerA.membershipId}`).rejects.toThrow(/at least one active owner/);
    const second = await addMember(owner, a.tenantId, "owner");
    await owner`update memberships set is_active = false where id = ${second.membershipId}`;
    await owner`update memberships set role = 'admin' where id = ${second.membershipId}`;
  });

  it("checks attribute values against their kind and keeps them per person", async () => {
    const context = staffContext(a, { membershipId: ownerA.membershipId, userId: ownerA.userId });
    const language = await createAttribute(context, { name: "Language", kind: "multiple", options: ["English", "Hindi", "Tamil"] });
    const years = await createAttribute(context, { name: "Years of practice", kind: "number", options: [] });
    await setPersonAttributes(context, a.practitionerId, { values: { [language.id]: ["English", "Hindi"], [years.id]: 12 } });
    const people = await listPersonAttributes(context);
    expect(people.find((person) => person.practitionerId === a.practitionerId)?.values).toEqual({ [language.id]: ["English", "Hindi"], [years.id]: 12 });
    expect((await failure(setPersonAttributes(context, a.practitionerId, { values: { [language.id]: ["Klingon"] } }))).code).toBe("invalid_attribute_value");
    expect((await failure(setPersonAttributes(context, a.practitionerId, { values: { [years.id]: "twelve" } }))).code).toBe("invalid_attribute_value");
    await setPersonAttributes(context, a.practitionerId, { values: { [years.id]: null } });
    expect((await listPersonAttributes(context)).find((person) => person.practitionerId === a.practitionerId)?.values[years.id]).toBeUndefined();
    // Another business cannot set values for this person.
    expect((await failure(setPersonAttributes(staffContext(b), a.practitionerId, { values: { [language.id]: ["English"] } }))).status).toBe(404);
  });

  it("saves organisation defaults with a version check, and keeps free text out of the audit trail", async () => {
    const context = staffContext(a, { membershipId: ownerA.membershipId, userId: ownerA.userId });
    const saved = await saveOrgDefaults(context, { timezone: "Asia/Kolkata", clock: "24h", weekStart: "monday", confirmationMessage: "Zinnia-private-wording" });
    expect(saved.version).toBe(1);
    expect((await failure(saveOrgDefaults(context, { timezone: "Mars/Olympus" }))).code).toBe("invalid_timezone");
    expect((await failure(saveOrgDefaults(context, { clock: "12h", version: 0 }))).code).toBe("version_conflict");
    expect((await getOrgDefaults(context)).confirmationMessage).toBe("Zinnia-private-wording");
    const audit = await owner`select metadata::text as metadata from audit_events where tenant_id = ${a.tenantId}`;
    expect(audit.some((row) => String(row.metadata).includes("Zinnia-private-wording"))).toBe(false);
  });

  it("filters the activity log by person, kind, outcome and day, and lists every failed sign-in", async () => {
    const context = staffContext(a, { membershipId: ownerA.membershipId, userId: ownerA.userId });
    const now = Date.now();
    // 60 failed sign-ins last week (more than one page), one just outside the week, one success, one in another business.
    for (let index = 0; index < 60; index += 1) {
      await owner`insert into audit_events (tenant_id, actor_user_id, actor_type, action, outcome, metadata, occurred_at)
        values (${a.tenantId}, ${frontDesk.userId}, 'staff', 'staff.sign_in.failed', 'failed', ${owner.json({ method: "password" })}, ${new Date(now - (index % 6) * 86_400_000 - index * 1000)})`;
    }
    await owner`insert into audit_events (tenant_id, actor_user_id, actor_type, action, outcome, metadata, occurred_at)
      values (${a.tenantId}, ${frontDesk.userId}, 'staff', 'staff.sign_in.failed', 'failed', '{}', ${new Date(now - 9 * 86_400_000)})`;
    await owner`insert into audit_events (tenant_id, actor_user_id, actor_type, action, outcome, metadata) values (${a.tenantId}, ${frontDesk.userId}, 'staff', 'staff.sign_in', 'success', '{}')`;
    await owner`insert into audit_events (tenant_id, actor_type, action, outcome, metadata) values (${b.tenantId}, 'staff', 'staff.sign_in.failed', 'failed', '{}')`;
    const from = new Date(now - 7 * 86_400_000).toISOString().slice(0, 10);
    const entries = [];
    let cursor: string | null = null;
    do {
      const page = await listActivity(context, { action: "failed_sign_in", from, cursor });
      entries.push(...page.entries);
      cursor = page.nextCursor;
    } while (cursor);
    expect(entries).toHaveLength(60);
    expect(entries.every((entry) => entry.outcome === "failed" && entry.summary === "A sign-in failed")).toBe(true);
    const bySomeoneElse = await listActivity(context, { actor: ownerA.userId, action: "failed_sign_in" });
    expect(bySomeoneElse.entries).toHaveLength(0);
    const denied = await listActivity(context, { outcome: "success", action: "sign_in" });
    expect(denied.entries.length).toBeGreaterThan(0);
  });
});
