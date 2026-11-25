/** @vitest-environment node */

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resolvePermissions } from "@/lib/permissions";
import { loadBusinessProfile, updateBusinessProfile } from "@/server/business-profile";
import type { StaffContext } from "@/server/staff-context";
import { findOwnJobTitle, updateOwnProfile, updateStaffMember } from "@/server/staff-team";
import { describeScratch } from "@/server/testing/scratch-database";
import { createSchedulingFixture, type SchedulingFixture } from "@/server/testing/scheduling-fixture";

const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? "";

describeScratch("the business's own role names and a person's job title", () => {
  let fixture: SchedulingFixture;
  let owner: StaffContext;
  let target: { membershipId: string; userId: string };
  let original: { terminology: unknown; business_type: string; features: unknown } | undefined;
  let originalTitles: { id: string; job_title: string | null }[] = [];

  beforeAll(async () => {
    fixture = await createSchedulingFixture(ownerUrl, { name: "Names" });
    [original] = await fixture.owner<{ terminology: unknown; business_type: string; features: unknown }[]>`select terminology, business_type, features from tenants where id = ${fixture.tenantId}`;
    originalTitles = await fixture.owner<{ id: string; job_title: string | null }[]>`select id, job_title from memberships where tenant_id = ${fixture.tenantId}`;
    const [ownerMember] = await fixture.owner<{ id: string; user_id: string }[]>`select id, user_id from memberships where tenant_id = ${fixture.tenantId} and role = 'owner' limit 1`;
    const [other] = await fixture.owner<{ id: string; user_id: string }[]>`select id, user_id from memberships where tenant_id = ${fixture.tenantId} and role <> 'owner' and is_active limit 1`;
    if (!ownerMember || !other) throw new Error("The seeded business needs an owner and one more person.");
    owner = { ...fixture.context, membershipId: ownerMember.id, userId: ownerMember.user_id, role: "owner", permissions: resolvePermissions("owner", {}) };
    target = { membershipId: other.id, userId: other.user_id };
  });

  afterAll(async () => {
    // Saving the business profile also writes its type and features, so all three go back as they were.
    if (original) {
      await fixture.owner`update tenants set terminology = ${fixture.owner.json(original.terminology as never)}, business_type = ${original.business_type}, features = ${fixture.owner.json(original.features as never)} where id = ${fixture.tenantId}`;
    }
    for (const row of originalTitles) await fixture.owner`update memberships set job_title = ${row.job_title} where id = ${row.id}`;
    await fixture.cleanup();
  });

  const profileInput = { businessType: "dental", terminology: {}, features: {} };

  it("keeps renamed roles with the business's words, and loads them back", async () => {
    await updateBusinessProfile(owner, { ...profileInput, roleNames: { receptionist: "  Front   desk ", practitioner: "Team" } });
    const profile = await loadBusinessProfile(fixture.tenantId);
    expect(profile.roleNameOverrides).toEqual({ receptionist: "Front desk", practitioner: "Team" });
    const [row] = await fixture.owner<{ terminology: { roles?: Record<string, string> } }[]>`select terminology from tenants where id = ${fixture.tenantId}`;
    expect(row!.terminology.roles).toEqual({ receptionist: "Front desk", practitioner: "Team" });
  });

  it("leaves the stored role names alone when a save does not mention them, and clears them with an empty set", async () => {
    await updateBusinessProfile(owner, { ...profileInput, terminology: { customer: { singular: "guest", plural: "guests" } } });
    expect((await loadBusinessProfile(fixture.tenantId)).roleNameOverrides).toEqual({ receptionist: "Front desk", practitioner: "Team" });
    await updateBusinessProfile(owner, { ...profileInput, roleNames: {} });
    expect((await loadBusinessProfile(fixture.tenantId)).roleNameOverrides).toEqual({});
  });

  it("audits which roles were renamed and never the names", async () => {
    const secret = `Role${crypto.randomUUID().slice(0, 8)}`;
    await updateBusinessProfile(owner, { ...profileInput, roleNames: { billing: secret } });
    const rows = await fixture.owner<{ metadata: Record<string, unknown> }[]>`
      select metadata from audit_events where tenant_id = ${fixture.tenantId} and action = 'settings.business_profile' order by occurred_at desc limit 1`;
    expect(rows[0]!.metadata.renamedRoles).toEqual(["billing"]);
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain(secret);
  });

  it("sets and clears someone's job title without a second-factor check, and audits only that it changed", async () => {
    const title = `Senior stylist ${crypto.randomUUID().slice(0, 6)}`;
    await updateStaffMember(owner, target.membershipId, { jobTitle: title });
    const [row] = await fixture.owner<{ job_title: string | null; role: string }[]>`select job_title, role from memberships where id = ${target.membershipId}`;
    expect(row!.job_title).toBe(title);
    const [audit] = await fixture.owner<{ action: string; metadata: Record<string, unknown> }[]>`
      select action, metadata from audit_events where tenant_id = ${fixture.tenantId} and metadata->>'membershipId' = ${target.membershipId} order by occurred_at desc limit 1`;
    expect(audit!.action).toBe("staff.member.job_title_changed");
    expect(audit!.metadata.changed).toEqual(["jobTitle"]);
    expect(JSON.stringify(audit!.metadata)).not.toContain(title);
    await updateStaffMember(owner, target.membershipId, { jobTitle: null });
    const [cleared] = await fixture.owner<{ job_title: string | null }[]>`select job_title from memberships where id = ${target.membershipId}`;
    expect(cleared!.job_title).toBeNull();
  });

  it("lets a person set their own title, and reads it back for the sidebar", async () => {
    await updateOwnProfile(owner, { jobTitle: "Owner and colourist" });
    expect(await findOwnJobTitle(owner)).toBe("Owner and colourist");
    await updateOwnProfile(owner, { jobTitle: null });
    expect(await findOwnJobTitle(owner)).toBeNull();
  });

  it("does not let someone without team access change another person's title", async () => {
    const reader: StaffContext = { ...owner, role: "read_only", permissions: resolvePermissions("read_only", {}) };
    await expect(updateStaffMember(reader, target.membershipId, { jobTitle: "Boss" })).rejects.toMatchObject({ status: 403 });
  });

  it("keeps another business's people out of reach", async () => {
    await expect(updateStaffMember(fixture.outsider, target.membershipId, { jobTitle: "Intruder" })).rejects.toMatchObject({ status: 404 });
    const [row] = await fixture.owner<{ job_title: string | null }[]>`select job_title from memberships where id = ${target.membershipId}`;
    expect(row!.job_title).toBeNull();
  });
});
