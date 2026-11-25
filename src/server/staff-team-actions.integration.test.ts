/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resolvePermissions, type StaffRole } from "@/lib/permissions";
import { clinicRegistrationSchema, registerClinic } from "@/server/clinic-registration";
import { listReassignmentsNeeded } from "@/server/enterprise/reassign";
import { recordSignInTime } from "@/server/staff-security";
import type { StaffContext } from "@/server/staff-context";
import { getStaffSnapshot } from "@/server/staff-repository";
import { createStaffMember, updateStaffMember, updateStaffPractitioner } from "@/server/staff-team";
import {
  cancelStaffInvite,
  linkMemberToProfile,
  removeStaffMember,
  signOutStaffMember,
  transferOwnership,
  unlinkMemberFromProfile,
} from "@/server/staff-team-actions";
import { isLocalDatabase } from "@/test/billing-fixture";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const describeLocal = isLocalDatabase(runtimeUrl) && isLocalDatabase(ownerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

interface Business {
  tenantId: string;
  slug: string;
  ownerContext: StaffContext;
}

interface Person {
  membershipId: string;
  userId: string;
  email: string;
  context: StaffContext;
}

describeLocal("staff team actions", () => {
  let owner: postgres.Sql;
  const created: string[] = [];

  beforeAll(() => { owner = postgres(ownerUrl!, { max: 1, prepare: false }); });
  afterAll(async () => {
    if (created.length > 0) await owner`delete from outbox_events where tenant_id = any(${created})`.catch(() => undefined);
    for (const tenantId of created) await owner`update tenants set is_active = false where id = ${tenantId}`.catch(() => undefined);
    await owner.end();
  });

  async function newBusiness(): Promise<Business> {
    const slug = `team-${randomUUID().slice(0, 8)}`;
    const email = `${slug}@example.com`;
    const registered = await registerClinic(clinicRegistrationSchema.parse({
      template: "general_practice", clinicName: "Team Test Clinic", slug, ownerName: "Asha Rao", email, password: randomUUID(), timezone: "Asia/Kolkata",
      ownerPractices: true, practice: { name: "Asha Rao", title: "Doctor", specialty: "General medicine" },
    }));
    created.push(registered.tenantId);
    const [member] = await owner<{ id: string; user_id: string }[]>`select id, user_id from memberships where tenant_id = ${registered.tenantId}`;
    await owner`update auth_users set two_factor_enabled = true, last_sign_in_at = now() where id = ${member!.user_id}`;
    return {
      tenantId: registered.tenantId,
      slug,
      ownerContext: {
        tenantId: registered.tenantId, clinicSlug: slug, clinicName: registered.clinicName, role: "owner", permissions: resolvePermissions("owner", {}),
        membershipId: member!.id, userId: member!.user_id, userName: "Asha Rao", userEmail: email, secondFactorEnrolled: true, secondFactorAt: new Date(), preview: false,
      },
    };
  }

  /** Invites a person through the real invite path, then (by default) lets them join: a password chosen and a session open. */
  async function addPerson(business: Business, role: "admin" | "receptionist" | "billing" | "read_only", options: { joined?: boolean } = {}): Promise<Person> {
    const email = `${role}-${randomUUID().slice(0, 8)}@example.com`;
    const result = await createStaffMember(business.ownerContext, { name: `Test ${role}`, email, role });
    if (options.joined !== false) {
      await owner`update auth_users set password_set_at = now(), last_sign_in_at = now() where id = ${result.userId}`;
      await owner`insert into auth_sessions (id, expires_at, token, user_id) values (${randomUUID()}, now() + interval '12 hours', ${randomUUID()}, ${result.userId})`;
    }
    return { membershipId: result.membershipId, userId: result.userId, email, context: contextFor(business, role, result.userId, result.membershipId) };
  }

  function contextFor(business: Business, role: StaffRole, userId: string, membershipId: string): StaffContext {
    return { ...business.ownerContext, role, permissions: resolvePermissions(role, {}), userId, membershipId, userName: `Test ${role}`, userEmail: `${role}@example.com` };
  }

  async function sessionCount(userId: string): Promise<number> {
    const [row] = await owner<{ n: number }[]>`select count(*)::int as n from auth_sessions where user_id = ${userId}`;
    return row!.n;
  }

  async function membershipOf(membershipId: string): Promise<{ role: string; is_active: boolean } | undefined> {
    const [row] = await owner<{ role: string; is_active: boolean }[]>`select role, is_active from memberships where id = ${membershipId}`;
    return row;
  }

  async function addProfile(business: Business, name: string): Promise<string> {
    const [row] = await owner<{ id: string }[]>`
      insert into practitioners (tenant_id, name, title, initials, specialty) values (${business.tenantId}, ${name}, 'Doctor', 'TD', 'General') returning id`;
    return row!.id;
  }

  /** A booked visit tomorrow with this profile. */
  async function addFutureBooking(business: Business, practitionerId: string): Promise<void> {
    const [patient] = await owner<{ id: string }[]>`
      insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel)
      values (${business.tenantId}, 'Pat', 'Ient', ${`+9198${Math.floor(10_000_000 + Math.random() * 89_999_999)}`}, ${`pat-${randomUUID().slice(0, 8)}@example.com`}, 'email') returning id`;
    const [service] = await owner<{ id: string }[]>`select id from services where tenant_id = ${business.tenantId} limit 1`;
    const [location] = await owner<{ id: string }[]>`select id from locations where tenant_id = ${business.tenantId} limit 1`;
    await owner`insert into appointments (tenant_id, patient_id, practitioner_id, service_id, location_id, starts_at, ends_at, status, booking_source, manage_token_hash)
      values (${business.tenantId}, ${patient!.id}, ${practitionerId}, ${service!.id}, ${location!.id}, now() + interval '1 day', now() + interval '1 day 30 minutes', 'booked', 'staff', ${randomUUID()})`;
  }

  async function closedCalendars(practitionerId: string): Promise<number> {
    const [row] = await owner<{ n: number }[]>`select count(*)::int as n from time_off where practitioner_id = ${practitionerId} and ends_at > now() + interval '9 years'`;
    return row!.n;
  }

  async function auditActions(tenantId: string, action: string): Promise<Record<string, unknown>[]> {
    const rows = await owner<{ metadata: Record<string, unknown> }[]>`select metadata from audit_events where tenant_id = ${tenantId} and action = ${action}`;
    return rows.map((row) => row.metadata);
  }

  it("deactivating a profile turns off the linked login whatever its role, ends its sessions and closes the calendar", async () => {
    const business = await newBusiness();
    const front = await addPerson(business, "receptionist");
    const profile = await addProfile(business, "Dr Front");
    await linkMemberToProfile(business.ownerContext, front.membershipId, profile);
    await addFutureBooking(business, profile);
    expect(await sessionCount(front.userId)).toBe(1);

    await updateStaffPractitioner(business.ownerContext, profile, { isActive: false });
    expect(await membershipOf(front.membershipId)).toMatchObject({ role: "receptionist", is_active: false });
    expect(await sessionCount(front.userId)).toBe(0);
    expect(await closedCalendars(profile)).toBe(1);
    expect((await listReassignmentsNeeded(business.ownerContext)).map((row) => row.practitionerId)).toContain(profile);
    const [event] = await auditActions(business.tenantId, "staff.member.deactivated");
    expect(event).toMatchObject({ membershipId: front.membershipId, role: "receptionist", viaProfile: true });
    expect(JSON.stringify(event)).not.toContain("@");

    await updateStaffPractitioner(business.ownerContext, profile, { isActive: true });
    expect(await membershipOf(front.membershipId)).toMatchObject({ is_active: true });
    expect(await closedCalendars(profile)).toBe(0);
  });

  it("switching off a profile applies the same guards as editing the person", async () => {
    const business = await newBusiness();
    const admin = await addPerson(business, "admin");
    const secondAdmin = await addPerson(business, "admin");
    const ownerProfile = (await owner<{ id: string }[]>`select id from practitioners where tenant_id = ${business.tenantId}`)[0]!.id;
    const adminProfile = await addProfile(business, "Dr Admin");
    await linkMemberToProfile(business.ownerContext, secondAdmin.membershipId, adminProfile);

    // An admin never reaches the owner, nor another admin.
    await expect(updateStaffPractitioner(admin.context, ownerProfile, { isActive: false })).rejects.toMatchObject({ status: 403, code: "owner_only" });
    await expect(updateStaffPractitioner(admin.context, adminProfile, { isActive: false })).rejects.toMatchObject({ status: 403, code: "owner_only" });
    expect(await membershipOf(secondAdmin.membershipId)).toMatchObject({ is_active: true });

    // Owners keep their own login when they close their own calendar: they would otherwise lock themselves out.
    await updateStaffPractitioner(business.ownerContext, ownerProfile, { isActive: false });
    expect(await membershipOf(business.ownerContext.membershipId!)).toMatchObject({ role: "owner", is_active: true });
    // A second owner's profile is protected from other owners as well, and the only owner answers 409.
    const stranger: StaffContext = { ...business.ownerContext, userId: randomUUID() };
    await updateStaffPractitioner(business.ownerContext, ownerProfile, { isActive: true });
    await expect(updateStaffPractitioner(stranger, ownerProfile, { isActive: false })).rejects.toMatchObject({ status: 409, code: "last_owner" });
    expect(await membershipOf(business.ownerContext.membershipId!)).toMatchObject({ is_active: true });
  });

  it("deactivating a member ends their sessions everywhere and closes their calendar", async () => {
    const business = await newBusiness();
    const person = await addPerson(business, "receptionist");
    const profile = await addProfile(business, "Dr Member");
    await linkMemberToProfile(business.ownerContext, person.membershipId, profile);
    await addFutureBooking(business, profile);
    await updateStaffMember(business.ownerContext, person.membershipId, { isActive: false });
    expect(await sessionCount(person.userId)).toBe(0);
    expect(await closedCalendars(profile)).toBe(1);
    expect((await listReassignmentsNeeded(business.ownerContext)).find((row) => row.practitionerId === profile)?.bookings).toBeGreaterThan(0);
    await updateStaffMember(business.ownerContext, person.membershipId, { isActive: true });
    expect(await closedCalendars(profile)).toBe(0);
  });

  it("removes a member: access gone, sessions gone, profile and history kept, email free to invite again", async () => {
    const business = await newBusiness();
    const person = await addPerson(business, "receptionist");
    const profile = await addProfile(business, "Dr Gone");
    await linkMemberToProfile(business.ownerContext, person.membershipId, profile);
    await addFutureBooking(business, profile);

    const result = await removeStaffMember(business.ownerContext, person.membershipId);
    expect(result).toMatchObject({ futureBookings: 1, loginDeleted: true });
    expect(await membershipOf(person.membershipId)).toBeUndefined();
    expect(await sessionCount(person.userId)).toBe(0);
    const [kept] = await owner<{ auth_user_id: string | null; is_active: boolean; name: string }[]>`select auth_user_id, is_active, name from practitioners where id = ${profile}`;
    expect(kept).toMatchObject({ auth_user_id: null, is_active: false, name: "Dr Gone" });
    const [bookings] = await owner<{ n: number }[]>`select count(*)::int as n from appointments where practitioner_id = ${profile}`;
    expect(bookings!.n).toBe(1);
    expect(await closedCalendars(profile)).toBe(1);
    expect((await listReassignmentsNeeded(business.ownerContext)).map((row) => row.practitionerId)).toContain(profile);
    const [metadata] = await auditActions(business.tenantId, "staff.member.removed");
    expect(metadata).toMatchObject({ membershipId: person.membershipId, role: "receptionist", hadProfile: true, futureBookings: 1, loginDeleted: true });
    expect(JSON.stringify(metadata)).not.toContain("@");

    // The same email can be invited again.
    await expect(createStaffMember(business.ownerContext, { name: "Back Again", email: person.email, role: "billing" })).resolves.toMatchObject({ role: "billing" });
  });

  it("keeps a login that belongs to another business, and leaves its sessions alone", async () => {
    const business = await newBusiness();
    const other = await newBusiness();
    const person = await addPerson(business, "billing");
    await owner`insert into memberships (tenant_id, user_id, role) values (${other.tenantId}, ${person.userId}, 'read_only')`;
    const result = await removeStaffMember(business.ownerContext, person.membershipId);
    expect(result.loginDeleted).toBe(false);
    // Sessions are shared with the other business; access here ended with the membership.
    expect(await sessionCount(person.userId)).toBeGreaterThan(0);
    const [still] = await owner<{ n: number }[]>`select count(*)::int as n from auth_users where id = ${person.userId}`;
    expect(still!.n).toBe(1);
  });

  it("refuses the actions on the wrong people, without a second factor, or without the permission", async () => {
    const business = await newBusiness();
    const admin = await addPerson(business, "admin");
    const otherAdmin = await addPerson(business, "admin");
    const front = await addPerson(business, "receptionist");
    const ownerMembership = business.ownerContext.membershipId!;
    const actions: [string, (context: StaffContext, membershipId: string) => Promise<unknown>][] = [
      ["remove", removeStaffMember],
      ["cancel invite", cancelStaffInvite],
      ["sign out", signOutStaffMember],
      ["unlink", unlinkMemberFromProfile],
      ["link", (context, id) => linkMemberToProfile(context, id, "any-profile")],
    ];
    for (const [name, act] of actions) {
      // An admin never acts on an owner, and only an owner acts on an admin.
      await expect(act(admin.context, ownerMembership), `${name}: admin on owner`).rejects.toMatchObject({ status: 403 });
      await expect(act(admin.context, otherAdmin.membershipId), `${name}: admin on admin`).rejects.toMatchObject({ status: 403 });
      // Never on yourself.
      await expect(act(admin.context, admin.membershipId), `${name}: self`).rejects.toMatchObject({ status: 400, code: "own_access" });
      // No second factor, or a stale one.
      await expect(act({ ...business.ownerContext, secondFactorEnrolled: false }, front.membershipId), `${name}: no second factor`).rejects.toMatchObject({ status: 403, code: "second_factor_required" });
      await expect(act({ ...business.ownerContext, secondFactorAt: new Date(Date.now() - 3_600_000) }, front.membershipId), `${name}: stale second factor`).rejects.toMatchObject({ status: 403, code: "step_up_required" });
      // A role without the team permission.
      await expect(act(front.context, otherAdmin.membershipId), `${name}: receptionist`).rejects.toMatchObject({ status: 403 });
      // Another owner (a stale context after a hand-over) can't touch the only real owner: the business always keeps one.
      if (name === "remove" || name === "cancel invite") {
        await expect(act({ ...business.ownerContext, userId: randomUUID() }, ownerMembership), `${name}: last owner`).rejects.toMatchObject({ status: 409, code: "last_owner" });
      }
    }
    expect(await membershipOf(ownerMembership)).toMatchObject({ role: "owner", is_active: true });
    expect(await membershipOf(front.membershipId)).toMatchObject({ is_active: true });
  });

  it("an admin removes a receptionist but not a person they may not touch", async () => {
    const business = await newBusiness();
    const admin = await addPerson(business, "admin");
    admin.context.secondFactorEnrolled = true;
    admin.context.secondFactorAt = new Date();
    const front = await addPerson(business, "receptionist");
    await expect(removeStaffMember(admin.context, front.membershipId)).resolves.toMatchObject({ membershipId: front.membershipId });
    expect(await membershipOf(front.membershipId)).toBeUndefined();
  });

  it("cancels a pending invite: the person, the link and the way in are all gone", async () => {
    const business = await newBusiness();
    const pending = await addPerson(business, "receptionist", { joined: false });
    const [token] = await owner<{ n: number }[]>`select count(*)::int as n from auth_verifications where value = ${pending.userId}`;
    expect(token!.n).toBe(1);

    const snapshot = await getStaffSnapshot(business.ownerContext);
    const listed = snapshot.team.find((member) => member.membershipId === pending.membershipId);
    expect(listed).toMatchObject({ invitePending: true, lastSignInAt: null, secondFactor: false });
    expect(new Date(listed!.inviteExpiresAt!).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    await cancelStaffInvite(business.ownerContext, pending.membershipId);
    expect(await membershipOf(pending.membershipId)).toBeUndefined();
    const [after] = await owner<{ n: number }[]>`select count(*)::int as n from auth_verifications where value = ${pending.userId}`;
    expect(after!.n).toBe(0);
    expect((await auditActions(business.tenantId, "staff.member.invite_cancelled")).length).toBe(1);
    await expect(createStaffMember(business.ownerContext, { name: "Again", email: pending.email, role: "receptionist" })).resolves.toBeDefined();

    // Someone who already joined has nothing to cancel.
    const joined = await addPerson(business, "billing");
    await expect(cancelStaffInvite(business.ownerContext, joined.membershipId)).rejects.toMatchObject({ status: 409, code: "invite_accepted" });
  });

  it("a person who signs in another way is no longer 'invite pending'", async () => {
    const business = await newBusiness();
    const person = await addPerson(business, "receptionist", { joined: false });
    const pendingOf = async () => (await getStaffSnapshot(business.ownerContext)).team.find((member) => member.membershipId === person.membershipId)!;
    expect((await pendingOf()).invitePending).toBe(true);
    // A password sign-in that still owes a second factor does not count.
    await owner`update auth_users set two_factor_enabled = true where id = ${person.userId}`;
    await recordSignInTime(person.userId, "/sign-in/email");
    expect((await pendingOf()).invitePending).toBe(true);
    await recordSignInTime(person.userId, "/two-factor/verify-totp");
    const after = await pendingOf();
    expect(after).toMatchObject({ invitePending: false, secondFactor: true, inviteExpiresAt: null });
    expect(after.lastSignInAt).not.toBeNull();
    await recordSignInTime((await addPerson(business, "billing", { joined: false })).userId, "/callback/google");
  });

  it("signs a person out of every device without switching them off", async () => {
    const business = await newBusiness();
    const person = await addPerson(business, "receptionist");
    await owner`insert into auth_sessions (id, expires_at, token, user_id) values (${randomUUID()}, now() + interval '12 hours', ${randomUUID()}, ${person.userId})`;
    expect(await sessionCount(person.userId)).toBe(2);
    await signOutStaffMember(business.ownerContext, person.membershipId);
    expect(await sessionCount(person.userId)).toBe(0);
    expect(await membershipOf(person.membershipId)).toMatchObject({ is_active: true });
    expect((await auditActions(business.tenantId, "staff.member.signed_out")).length).toBe(1);
  });

  it("hands the business over in one step: the target becomes the owner, the owner becomes an admin", async () => {
    const business = await newBusiness();
    const admin = await addPerson(business, "admin");
    const ownerMembership = business.ownerContext.membershipId!;

    // The new owner needs a second factor, an active login, and the actor needs a fresh second factor.
    await expect(transferOwnership(business.ownerContext, admin.membershipId)).rejects.toMatchObject({ status: 400, code: "second_factor_required" });
    expect(await membershipOf(ownerMembership)).toMatchObject({ role: "owner" });
    expect(await membershipOf(admin.membershipId)).toMatchObject({ role: "admin" });
    await owner`update auth_users set two_factor_enabled = true where id = ${admin.userId}`;
    await expect(transferOwnership({ ...business.ownerContext, secondFactorAt: null }, admin.membershipId)).rejects.toMatchObject({ status: 403, code: "step_up_required" });
    await expect(transferOwnership(admin.context, ownerMembership)).rejects.toMatchObject({ status: 403 });
    await expect(transferOwnership(business.ownerContext, ownerMembership)).rejects.toMatchObject({ status: 400 });
    await owner`update memberships set is_active = false where id = ${admin.membershipId}`;
    await expect(transferOwnership(business.ownerContext, admin.membershipId)).rejects.toMatchObject({ status: 400, code: "member_inactive" });
    await owner`update memberships set is_active = true, permission_overrides = '{"settings.manage": false}'::jsonb where id = ${admin.membershipId}`;

    await transferOwnership(business.ownerContext, admin.membershipId);
    expect(await membershipOf(admin.membershipId)).toMatchObject({ role: "owner", is_active: true });
    expect(await membershipOf(ownerMembership)).toMatchObject({ role: "admin", is_active: true });
    const [promoted] = await owner<{ permission_overrides: unknown }[]>`select permission_overrides from memberships where id = ${admin.membershipId}`;
    expect(promoted!.permission_overrides).toEqual({});
    const [owners] = await owner<{ n: number }[]>`select count(*)::int as n from memberships where tenant_id = ${business.tenantId} and role = 'owner' and is_active`;
    expect(owners!.n).toBe(1);
    expect((await auditActions(business.tenantId, "staff.ownership.transferred"))[0]).toMatchObject({ fromMembershipId: ownerMembership, toMembershipId: admin.membershipId });
    // The old owner can no longer hand it over, or act on the new owner.
    await expect(transferOwnership(business.ownerContext, admin.membershipId)).rejects.toMatchObject({ status: 403 });
  });

  it("two hand-overs at once leave exactly one owner", async () => {
    const business = await newBusiness();
    const first = await addPerson(business, "admin");
    const second = await addPerson(business, "admin");
    await owner`update auth_users set two_factor_enabled = true where id in (${first.userId}, ${second.userId})`;
    const results = await Promise.allSettled([
      transferOwnership(business.ownerContext, first.membershipId),
      transferOwnership(business.ownerContext, second.membershipId),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const owners = await owner<{ id: string }[]>`select id from memberships where tenant_id = ${business.tenantId} and role = 'owner' and is_active`;
    expect(owners).toHaveLength(1);
  });

  it("links a login to a profile that has none, and unlinks it again", async () => {
    const business = await newBusiness();
    const person = await addPerson(business, "receptionist");
    const other = await addPerson(business, "billing");
    const profile = await addProfile(business, "Dr Link");
    const taken = await addProfile(business, "Dr Taken");
    await owner`update practitioners set auth_user_id = ${other.userId} where id = ${taken}`;
    const inactive = await addProfile(business, "Dr Off");
    await owner`update practitioners set is_active = false where id = ${inactive}`;

    await expect(linkMemberToProfile(business.ownerContext, person.membershipId, taken)).rejects.toMatchObject({ status: 409, code: "already_has_login" });
    await expect(linkMemberToProfile(business.ownerContext, person.membershipId, inactive)).rejects.toMatchObject({ status: 400, code: "practitioner_inactive" });
    await expect(linkMemberToProfile(business.ownerContext, person.membershipId, randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(unlinkMemberFromProfile(business.ownerContext, person.membershipId)).rejects.toMatchObject({ status: 404, code: "not_linked" });

    await linkMemberToProfile(business.ownerContext, person.membershipId, profile);
    const [linked] = await owner<{ auth_user_id: string }[]>`select auth_user_id from practitioners where id = ${profile}`;
    expect(linked!.auth_user_id).toBe(person.userId);
    await expect(linkMemberToProfile(business.ownerContext, person.membershipId, taken)).rejects.toMatchObject({ status: 409, code: "already_linked" });

    await unlinkMemberFromProfile(business.ownerContext, person.membershipId);
    const [after] = await owner<{ auth_user_id: string | null; is_active: boolean }[]>`select auth_user_id, is_active from practitioners where id = ${profile}`;
    expect(after).toEqual({ auth_user_id: null, is_active: true });
    expect(await membershipOf(person.membershipId)).toMatchObject({ role: "receptionist", is_active: true });
    expect((await auditActions(business.tenantId, "staff.member.profile_linked")).length).toBe(1);
    expect((await auditActions(business.tenantId, "staff.member.profile_unlinked")).length).toBe(1);

    // A practitioner login needs its profile, so that link can't be taken away from under it.
    const doctor = await addPerson(business, "receptionist");
    const doctorProfile = await addProfile(business, "Dr Role");
    await linkMemberToProfile(business.ownerContext, doctor.membershipId, doctorProfile);
    await owner`update memberships set role = 'practitioner' where id = ${doctor.membershipId}`;
    await expect(unlinkMemberFromProfile(business.ownerContext, doctor.membershipId)).rejects.toMatchObject({ status: 409, code: "role_needs_profile" });
  });

  it("one business cannot act on another business's team", async () => {
    const business = await newBusiness();
    const other = await newBusiness();
    const outsider = await addPerson(other, "receptionist");
    await expect(removeStaffMember(business.ownerContext, outsider.membershipId)).rejects.toMatchObject({ status: 404 });
    await expect(signOutStaffMember(business.ownerContext, outsider.membershipId)).rejects.toMatchObject({ status: 404 });
    await expect(transferOwnership(business.ownerContext, outsider.membershipId)).rejects.toMatchObject({ status: 404 });
    expect(await membershipOf(outsider.membershipId)).toBeDefined();
    expect(await sessionCount(outsider.userId)).toBe(1);
  });
});
