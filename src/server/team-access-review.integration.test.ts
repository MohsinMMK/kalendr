/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { resolvePermissions } from "@/lib/permissions";
import { ApiError } from "@/server/api-error";
import { clinicRegistrationSchema, registerClinic } from "@/server/clinic-registration";
import { staffCreatePractitionerSchema } from "@/server/contracts";
import type { StaffContext } from "@/server/staff-context";
import { changeMemberEmail } from "@/server/staff-email";
import { afterOwnEmailConfirmed } from "@/server/staff-email-change";
import { createStaffMember, createStaffPractitioner, invitePractitionerLogin, sendMemberAccessLink, updateStaffMember } from "@/server/staff-team";
import { removeStaffMember, signOutStaffMember } from "@/server/staff-team-actions";
import { addMember, contextForMember, type MemberFixture } from "@/test/enterprise-fixture";
import { isLocalDatabase } from "@/test/billing-fixture";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const describeLocal = isLocalDatabase(runtimeUrl) && isLocalDatabase(ownerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

const password = `Pw-${randomUUID()}`;

interface Business {
  id: string;
  slug: string;
  ownerContext: StaffContext;
  locationA: string;
  locationB: string;
}

describeLocal("team access review fixes", () => {
  let owner: postgres.Sql;
  const created: string[] = [];
  const suffix = randomUUID().slice(0, 6);
  let x: Business;
  let y: Business;
  /** An admin of X limited to location A. */
  let limitedAdmin: MemberFixture;
  let limited: StaffContext;

  const address = (label: string) => `${label}-${suffix}-${randomUUID().slice(0, 4)}@example.com`;
  const refusal = async (work: Promise<unknown>): Promise<ApiError> => {
    try { await work; } catch (error: unknown) { if (error instanceof ApiError) return error; throw error; }
    throw new Error("Expected the call to be refused.");
  };
  const locationsOf = async (membershipId: string): Promise<string[]> =>
    (await owner<{ location_id: string }[]>`select location_id from membership_locations where membership_id = ${membershipId} order by location_id`).map((row) => row.location_id);

  async function register(label: string): Promise<Business> {
    const slug = `review-${label}-${suffix}`;
    const email = address(`own-${label}`);
    const registered = await registerClinic(clinicRegistrationSchema.parse({
      template: "general_practice", clinicName: `Review ${label}`, slug, ownerName: "Asha Rao", email, password, timezone: "Asia/Kolkata", ownerPractices: false,
    }));
    created.push(registered.tenantId);
    const [member] = await owner<{ id: string; user_id: string }[]>`select id, user_id from memberships where tenant_id = ${registered.tenantId}`;
    const [first] = await owner<{ id: string }[]>`select id from locations where tenant_id = ${registered.tenantId} limit 1`;
    const [second] = await owner<{ id: string }[]>`
      insert into locations (tenant_id, name, address, city, timezone) values (${registered.tenantId}, 'Second branch', '2 Test Road', 'Pune', 'Asia/Kolkata') returning id`;
    return {
      id: registered.tenantId,
      slug,
      locationA: first!.id,
      locationB: second!.id,
      ownerContext: {
        tenantId: registered.tenantId, clinicSlug: slug, clinicName: registered.clinicName, role: "owner", permissions: resolvePermissions("owner", {}),
        membershipId: member!.id, userId: member!.user_id, userName: "Asha Rao", userEmail: email, locationIds: null, secondFactorEnrolled: true, secondFactorAt: new Date(), preview: false,
      },
    };
  }

  /** A staff member of X with a password set, optionally limited to some locations. */
  async function teammate(limitTo: string[] = []): Promise<MemberFixture> {
    const member = await addMember(owner, x.id, "receptionist");
    for (const locationId of limitTo) await owner`insert into membership_locations (tenant_id, membership_id, location_id) values (${x.id}, ${member.membershipId}, ${locationId})`;
    return member;
  }

  async function sessionFor(userId: string): Promise<void> {
    await owner`insert into auth_sessions (id, token, user_id, expires_at) values (${randomUUID()}, ${randomUUID()}, ${userId}, now() + interval '1 day')`;
  }
  async function linkFor(userId: string): Promise<void> {
    await owner`insert into auth_verifications (id, identifier, value, expires_at) values (${randomUUID()}, ${`reset-password:${randomUUID()}`}, ${userId}, now() + interval '1 day')`;
  }
  const counts = async (userId: string) => ({
    sessions: (await owner<{ n: number }[]>`select count(*)::int as n from auth_sessions where user_id = ${userId}`)[0]!.n,
    links: (await owner<{ n: number }[]>`select count(*)::int as n from auth_verifications where value = ${userId}`)[0]!.n,
    users: (await owner<{ n: number }[]>`select count(*)::int as n from auth_users where id = ${userId}`)[0]!.n,
  });
  /** The same login also holds a membership in Y, switched on or off. */
  async function alsoIn(business: Business, userId: string, isActive: boolean): Promise<void> {
    await owner`insert into memberships (tenant_id, user_id, role, is_active) values (${business.id}, ${userId}, 'receptionist', ${isActive})`;
  }

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 1, prepare: false });
    x = await register("x");
    y = await register("y");
    limitedAdmin = await addMember(owner, x.id, "admin");
    await owner`insert into membership_locations (tenant_id, membership_id, location_id) values (${x.id}, ${limitedAdmin.membershipId}, ${x.locationA})`;
    limited = await contextForMember({ tenantId: x.id, slug: x.slug }, limitedAdmin, { locationIds: [x.locationA] });
  });

  afterAll(async () => {
    for (const id of created) {
      await owner`delete from outbox_events where tenant_id = ${id}`.catch(() => undefined);
      await owner`update tenants set is_active = false where id = ${id}`.catch(() => undefined);
    }
    await owner.end();
  });

  describe("1. a limited manager only creates limited staff", () => {
    it("defaults a new login to the manager's own locations, and refuses locations outside them", async () => {
      const made = await createStaffMember(limited, { name: "New Reception", email: address("n1"), role: "receptionist" });
      expect(await locationsOf(made.membershipId)).toEqual([x.locationA]);
      const refused = await refusal(createStaffMember(limited, { name: "Wide", email: address("n2"), role: "receptionist", locationIds: [x.locationB] }));
      expect(refused.code).toBe("cannot_grant");
    });

    it("limits an existing login added by a limited manager, and leaves an every-location manager's choice alone", async () => {
      const existing = address("shared");
      await createStaffMember(y.ownerContext, { name: "Shared Person", email: existing, role: "receptionist" });
      const [row] = await owner<{ id: string }[]>`select id from auth_users where email = ${existing}`;
      await owner`update auth_users set password_set_at = now(), last_sign_in_at = now() where id = ${row!.id}`;
      const added = await createStaffMember(limited, { name: "Shared Person", email: existing, role: "receptionist" });
      // An existing login gets an invite, not a membership; the limit is kept on the invite and carried over on accept.
      const [invite] = await owner<{ location_ids: string[] }[]>`select location_ids from staff_login_invites where id = ${added.membershipId}`;
      expect(invite!.location_ids).toEqual([x.locationA]);
      expect(await locationsOf(added.membershipId)).toEqual([]);
      const unlimited = await createStaffMember(x.ownerContext, { name: "Everywhere", email: address("n3"), role: "receptionist" });
      expect(await locationsOf(unlimited.membershipId)).toEqual([]);
    });

    it("limits a doctor's login made through the doctor profile and the invite-to-profile path", async () => {
      const doctor = await createStaffPractitioner(limited, staffCreatePractitionerSchema.parse({
        name: "Dr Limited", title: "Doctor", specialty: "General", email: address("doc"),
        locationIds: [x.locationA], serviceIds: [(await owner<{ id: string }[]>`select id from services where tenant_id = ${x.id} limit 1`)[0]!.id],
        hours: { days: [1, 2, 3], startsAtLocal: "09:00", endsAtLocal: "17:00" },
      }));
      const [doctorMembership] = await owner<{ id: string }[]>`select id from memberships where tenant_id = ${x.id} and user_id = ${doctor.userId}`;
      expect(await locationsOf(doctorMembership!.id)).toEqual([x.locationA]);

      const [profile] = await owner<{ id: string }[]>`
        insert into practitioners (tenant_id, name, title, initials, specialty) values (${x.id}, 'Dr No Login', 'Doctor', 'NL', 'General') returning id`;
      const invited = await invitePractitionerLogin(limited, profile!.id, address("nologin"));
      expect(await locationsOf(invited.membershipId)).toEqual([x.locationA]);
    });
  });

  describe("2. a limited manager can't act on people who work beyond their locations", () => {
    it("refuses every action on a teammate who sees every location or another one, and allows one inside their own", async () => {
      const everywhere = await teammate();
      const both = await teammate([x.locationA, x.locationB]);
      const inside = await teammate([x.locationA]);

      for (const target of [everywhere, both]) {
        expect((await refusal(updateStaffMember(limited, target.membershipId, { isActive: false }))).code).toBe("cannot_manage_location");
        expect((await refusal(removeStaffMember(limited, target.membershipId))).code).toBe("cannot_manage_location");
        expect((await refusal(signOutStaffMember(limited, target.membershipId))).code).toBe("cannot_manage_location");
        expect((await refusal(sendMemberAccessLink(limited, target.membershipId))).code).toBe("cannot_manage_location");
        expect((await refusal(changeMemberEmail(limited, target.membershipId, { newEmail: address("moved") }))).code).toBe("cannot_manage_location");
      }
      const [still] = await owner<{ is_active: boolean }[]>`select is_active from memberships where id = ${everywhere.membershipId}`;
      expect(still!.is_active).toBe(true);

      await updateStaffMember(limited, inside.membershipId, { isActive: false });
      const [off] = await owner<{ is_active: boolean }[]>`select is_active from memberships where id = ${inside.membershipId}`;
      expect(off!.is_active).toBe(false);
      // An every-location manager is not held back.
      await updateStaffMember(x.ownerContext, everywhere.membershipId, { isActive: false });
    });
  });

  describe("3. the shared-login guard counts switched-off memberships and suspended businesses", () => {
    it("treats a login held only by a switched-off membership elsewhere as shared", async () => {
      const person = await teammate();
      await alsoIn(y, person.userId, false);
      expect((await refusal(changeMemberEmail(x.ownerContext, person.membershipId, { newEmail: address("blocked") }))).code).toBe("shared_login");
      expect((await refusal(sendMemberAccessLink(x.ownerContext, person.membershipId))).code).toBe("shared_login");
    });

    it("treats a login held in a suspended business as shared", async () => {
      const z = await register("z");
      const person = await teammate();
      await alsoIn(z, person.userId, true);
      await owner`update tenants set is_active = false where id = ${z.id}`;
      expect((await refusal(changeMemberEmail(x.ownerContext, person.membershipId, { newEmail: address("blocked2") }))).code).toBe("shared_login");
      expect((await refusal(sendMemberAccessLink(x.ownerContext, person.membershipId))).code).toBe("shared_login");
    });

    it("still lets a one-business login be changed", async () => {
      const person = await teammate();
      const link = await sendMemberAccessLink(x.ownerContext, person.membershipId);
      expect(link.kind).toBe("reset");
    });
  });

  describe("4. one business can't sign a shared login out of the others", () => {
    it("keeps sessions and links when a shared person is removed or switched off, and refuses sign-out everywhere", async () => {
      const shared = await teammate();
      await alsoIn(y, shared.userId, true);
      await sessionFor(shared.userId);
      await linkFor(shared.userId);

      expect((await refusal(signOutStaffMember(x.ownerContext, shared.membershipId))).code).toBe("shared_login");
      expect(await counts(shared.userId)).toEqual({ sessions: 1, links: 1, users: 1 });

      await updateStaffMember(x.ownerContext, shared.membershipId, { isActive: false });
      expect(await counts(shared.userId)).toEqual({ sessions: 1, links: 1, users: 1 });

      const removed = await removeStaffMember(x.ownerContext, shared.membershipId);
      expect(removed.loginDeleted).toBe(false);
      expect(await counts(shared.userId)).toEqual({ sessions: 1, links: 1, users: 1 });
      const [stillThere] = await owner<{ n: number }[]>`select count(*)::int as n from memberships where tenant_id = ${y.id} and user_id = ${shared.userId}`;
      expect(stillThere!.n).toBe(1);
    });

    it("still ends sessions and links for a person who works only here", async () => {
      const solo = await teammate();
      await sessionFor(solo.userId);
      await linkFor(solo.userId);
      await updateStaffMember(x.ownerContext, solo.membershipId, { isActive: false });
      expect(await counts(solo.userId)).toMatchObject({ sessions: 0 });

      const other = await teammate();
      await sessionFor(other.userId);
      await signOutStaffMember(x.ownerContext, other.membershipId);
      expect((await counts(other.userId)).sessions).toBe(0);
    });
  });

  describe("5. changing your own email closes the old ways in", () => {
    async function changedEmail(passwordSet: boolean): Promise<MemberFixture> {
      const person = await teammate();
      const oldEmail = person.email;
      const newEmail = address("fresh");
      if (!passwordSet) await owner`update auth_users set password_set_at = null where id = ${person.userId}`;
      else await owner`insert into auth_accounts (id, account_id, provider_id, user_id, password) values (${randomUUID()}, ${person.userId}, 'credential', ${person.userId}, 'hashed')`;
      await owner`insert into auth_accounts (id, account_id, provider_id, user_id) values (${randomUUID()}, ${randomUUID()}, 'google', ${person.userId})`;
      await linkFor(person.userId);
      await owner`update auth_users set email = ${newEmail} where id = ${person.userId}`;
      await afterOwnEmailConfirmed({
        change: { email: oldEmail, updateTo: newEmail, requestType: "change-email-verification", userId: person.userId },
        emailBefore: oldEmail,
      }, null);
      return person;
    }
    const providers = async (userId: string) => (await owner<{ provider_id: string }[]>`select provider_id from auth_accounts where user_id = ${userId} order by provider_id`).map((row) => row.provider_id);

    it("deletes outstanding links and unlinks Google when the person has a password", async () => {
      const person = await changedEmail(true);
      expect((await counts(person.userId)).links).toBe(0);
      expect(await providers(person.userId)).toEqual(["credential"]);
    });

    it("keeps a Google-only person's sign-in so they are not locked out", async () => {
      const person = await changedEmail(false);
      expect((await counts(person.userId)).links).toBe(0);
      expect(await providers(person.userId)).toEqual(["google"]);
    });
  });

  describe("6. sensitive team actions need a fresh code", () => {
    it("asks for a second-factor check before creating a login, sending a link or giving a profile a login", async () => {
      const stale: StaffContext = { ...x.ownerContext, secondFactorAt: new Date(Date.now() - 60 * 60_000) };
      const person = await teammate();
      const [profile] = await owner<{ id: string }[]>`
        insert into practitioners (tenant_id, name, title, initials, specialty) values (${x.id}, 'Dr Stale', 'Doctor', 'DS', 'General') returning id`;
      expect((await refusal(createStaffMember(stale, { name: "Nope", email: address("stale"), role: "receptionist" }))).code).toBe("step_up_required");
      expect((await refusal(sendMemberAccessLink(stale, person.membershipId))).code).toBe("step_up_required");
      expect((await refusal(invitePractitionerLogin(stale, profile!.id, address("stale2")))).code).toBe("step_up_required");
    });
  });
});
