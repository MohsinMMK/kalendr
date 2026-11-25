/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { auth } from "@/lib/auth";
import { activeBusinessCookie } from "@/lib/active-business";
import { resolvePermissions } from "@/lib/permissions";
import { ACCOUNT_EMAIL_NOTICE_EVENT, ACCOUNT_EMAIL_NOTICE_PURPOSE, accountEmailNoticeSecretSchema } from "@/lib/staff-email";
import { POST as switchBusiness } from "@/app/api/staff/business/switch/route";
import { POST as acceptRoute } from "@/app/api/staff/invites/[id]/accept/route";
import { POST as declineRoute } from "@/app/api/staff/invites/[id]/decline/route";
import { ApiError } from "@/server/api-error";
import { clinicRegistrationSchema, registerClinic } from "@/server/clinic-registration";
import { openPrivate } from "@/server/messaging/sealed-link";
import { staffCreatePractitionerSchema } from "@/server/contracts";
import { getStaffContext, type StaffContext } from "@/server/staff-context";
import { changeMemberEmail } from "@/server/staff-email";
import { acceptLoginInvite, listMyInvites } from "@/server/staff-login-invites";
import { getStaffSnapshot } from "@/server/staff-repository";
import { createStaffMember, createStaffPractitioner, invitePractitionerLogin, sendMemberAccessLink } from "@/server/staff-team";
import { removeStaffMember } from "@/server/staff-team-actions";
import { isLocalDatabase } from "@/test/billing-fixture";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const describeLocal = isLocalDatabase(runtimeUrl) && isLocalDatabase(ownerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

const password = `Pw-${randomUUID()}`;

interface Business {
  id: string;
  slug: string;
  ownerContext: StaffContext;
}

describeLocal("one login, many businesses", () => {
  let owner: postgres.Sql;
  const created: string[] = [];
  const suffix = randomUUID().slice(0, 6);
  let a: Business;
  let b: Business;
  let c: Business;

  const address = (label: string) => `${label}-${suffix}-${randomUUID().slice(0, 4)}@example.com`;

  async function register(label: string, clinicName: string): Promise<Business> {
    const slug = `multi-${label}-${suffix}`;
    const email = address(`own-${label}`);
    const registered = await registerClinic(clinicRegistrationSchema.parse({
      template: "general_practice", clinicName, slug, ownerName: "Asha Rao", email, password, timezone: "Asia/Kolkata", ownerPractices: false,
    }));
    created.push(registered.tenantId);
    const [member] = await owner<{ id: string; user_id: string }[]>`select id, user_id from memberships where tenant_id = ${registered.tenantId}`;
    return {
      id: registered.tenantId,
      slug,
      ownerContext: {
        tenantId: registered.tenantId, clinicSlug: slug, clinicName: registered.clinicName, role: "owner", permissions: resolvePermissions("owner", {}),
        membershipId: member!.id, userId: member!.user_id, userName: "Asha Rao", userEmail: email, secondFactorEnrolled: true, secondFactorAt: new Date(), preview: false,
      },
    };
  }

  /** The person has accepted their invite: a password they know, and they have signed in once. */
  async function activate(userId: string): Promise<void> {
    await owner`update auth_accounts set password = ${await hashPassword(password)} where user_id = ${userId} and provider_id = 'credential'`;
    await owner`update auth_users set password_set_at = now(), last_sign_in_at = now() where id = ${userId}`;
  }

  /** A working staff member of `business`, created through the real invite path and activated. */
  async function colleague(business: Business, role: "receptionist" | "billing" = "receptionist"): Promise<{ userId: string; email: string; membershipId: string }> {
    const email = address(role);
    const result = await createStaffMember(business.ownerContext, { name: `Test ${role}`, email, role });
    await activate(result.userId);
    return { userId: result.userId, email, membershipId: result.membershipId };
  }

  async function signIn(email: string, slug?: string): Promise<Headers> {
    const response = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    const cookies = response.headers.getSetCookie().map((line) => line.split(";")[0]!);
    if (slug) cookies.push(`${activeBusinessCookie}=${slug}`);
    return new Headers({ cookie: cookies.join("; ") });
  }

  async function notices(tenant: string): Promise<Array<{ kind: string; to: string; business: string }>> {
    const rows = await owner<{ aggregate_id: string; payload: { kind: string; sealed: string } }[]>`
      select aggregate_id, payload from outbox_events where tenant_id = ${tenant} and event_type = ${ACCOUNT_EMAIL_NOTICE_EVENT} order by created_at`;
    return rows.map((row) => {
      const secret = accountEmailNoticeSecretSchema.parse(JSON.parse(openPrivate(ACCOUNT_EMAIL_NOTICE_PURPOSE, tenant, row.aggregate_id, row.payload.sealed) ?? "{}"));
      return { kind: row.payload.kind, to: secret.email, business: secret.business };
    });
  }

  const usersWithEmail = async (email: string): Promise<number> => (await owner<{ n: number }[]>`select count(*)::int as n from auth_users where email = ${email}`)[0]!.n;
  const rejection = async (work: Promise<unknown>): Promise<ApiError> => {
    try { await work; } catch (error: unknown) { if (error instanceof ApiError) return error; throw error; }
    throw new Error("Expected the call to be refused.");
  };

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 1, prepare: false });
    // Names sort alphabetically, and the first business in that order is what a person lands on with no preference.
    a = await register("a", "Alpha Clinic");
    b = await register("b", "Beta Clinic");
    c = await register("c", "Gamma Clinic");
  });

  afterAll(async () => {
    for (const id of created) {
      await owner`delete from outbox_events where tenant_id = ${id}`.catch(() => undefined);
      await owner`update tenants set is_active = false where id = ${id}`.catch(() => undefined);
    }
    await owner.end();
  });

  /** B invites the person's existing login and they accept, as a working second membership. */
  async function join(business: Business, person: { userId: string; email: string }, input: { role?: "receptionist" | "billing"; locationIds?: string[] } = {}) {
    const invited = await createStaffMember(business.ownerContext, { name: "Shared", email: person.email, role: input.role ?? "billing", ...(input.locationIds ? { locationIds: input.locationIds } : {}) });
    await acceptLoginInvite(person.userId, invited.membershipId);
    return invited;
  }

  const membershipIn = async (tenantId: string, userId: string) =>
    (await owner<{ id: string; role: string; job_title: string | null }[]>`select id, role, job_title from memberships where tenant_id = ${tenantId} and user_id = ${userId}`)[0];

  describe("inviting an email that already has a login", () => {
    it("grants nothing until the person accepts, and answers exactly as for a brand-new email", async () => {
      const shared = await colleague(a);
      const before = await usersWithEmail(shared.email);

      const existing = await createStaffMember(b.ownerContext, { name: "A different name typed by B", email: ` ${shared.email.toUpperCase()} `, role: "billing", jobTitle: "Visiting accountant" });
      const brandNew = await createStaffMember(b.ownerContext, { name: "Someone new", email: address("new"), role: "billing", jobTitle: "Visiting accountant" });

      // The same answer: an invite link either way, and a user id that is neither the membership id nor the real login's.
      const shape = (created: typeof existing) => ({
        keys: Object.keys(created).sort(), linkKeys: Object.keys(created.invite).sort(), idsMatch: created.userId === created.membershipId, role: created.role,
      });
      expect(shape(existing)).toEqual(shape(brandNew));
      expect(existing.userId).not.toBe(shared.userId);
      expect(existing.invite.url).toMatch(/\/reset-password\?token=[^&]+&invite=1$/);
      expect(new URL(existing.invite.url).pathname).toBe(new URL(brandNew.invite.url).pathname);

      // No second account, and nothing granted: no membership, no access to B, B can't see the login's own name.
      expect(before).toBe(1);
      expect(await usersWithEmail(shared.email)).toBe(1);
      expect(await membershipIn(b.id, shared.userId)).toBeUndefined();
      const signedIn = await signIn(shared.email, b.slug);
      expect((await getStaffContext(signedIn)).clinicSlug).toBe(a.slug);
      await expect(getStaffContext(signedIn, b.slug)).rejects.toMatchObject({ status: 403 });

      // The same audit row, and no notice to the person beyond the invite itself.
      const audits = await owner<{ action: string; membership_id: string }[]>`
        select action, metadata->>'membershipId' as membership_id from audit_events where tenant_id = ${b.id} and metadata->>'membershipId' in (${existing.membershipId}, ${brandNew.membershipId}) order by action`;
      expect(audits.filter((row) => row.membership_id === existing.membershipId).map((row) => row.action)).toEqual(["staff.member.created"]);
      expect(audits.filter((row) => row.membership_id === brandNew.membershipId).map((row) => row.action)).toEqual(["staff.member.created"]);
      expect((await notices(b.id)).some((notice) => notice.to === shared.email)).toBe(false);

      // The team list shows both as invited people, alike in everything but their own name, email and ids.
      const team = (await getStaffSnapshot(b.ownerContext)).team;
      const row = (membershipId: string) => team.find((member) => member.membershipId === membershipId)!;
      const alike = (member: ReturnType<typeof row>) => {
        const { membershipId, userId, name, email, invitedAt, inviteExpiresAt, ...rest } = member;
        return { ...rest, hasIds: Boolean(membershipId && userId && name && email && invitedAt), expires: Boolean(inviteExpiresAt) };
      };
      expect(alike(row(existing.membershipId))).toEqual(alike(row(brandNew.membershipId)));
      expect(row(existing.membershipId)).toMatchObject({ name: "A different name typed by B", email: shared.email, userId: existing.userId, invitePending: true, jobTitle: "Visiting accountant" });
      expect(row(existing.membershipId).worksElsewhere).toBeUndefined();
    });

    it("makes the membership B chose when the person accepts, with its location limit", async () => {
      const shared = await colleague(a);
      const [location] = await owner<{ id: string }[]>`select id from locations where tenant_id = ${b.id} and is_active limit 1`;

      const invited = await createStaffMember(b.ownerContext, { name: "Shared", email: shared.email, role: "receptionist", jobTitle: "Front desk", locationIds: [location!.id] });
      await acceptLoginInvite(shared.userId, invited.membershipId);

      expect(await membershipIn(b.id, shared.userId)).toEqual({ id: invited.membershipId, role: "receptionist", job_title: "Front desk" });
      const limited = await owner<{ location_id: string }[]>`select location_id from membership_locations where tenant_id = ${b.id} and membership_id = ${invited.membershipId}`;
      expect(limited.map((row) => row.location_id)).toEqual([location!.id]);
      expect(await owner`select 1 from staff_login_invites where id = ${invited.membershipId}`).toHaveLength(0);
      const [accepted] = await owner<{ actor_user_id: string; metadata: Record<string, unknown> }[]>`
        select actor_user_id, metadata from audit_events where tenant_id = ${b.id} and action = 'staff.member.invite_accepted' and metadata->>'membershipId' = ${invited.membershipId}`;
      expect(accepted).toMatchObject({ actor_user_id: shared.userId, metadata: { membershipId: invited.membershipId, role: "receptionist" } });
      expect((await getStaffContext(await signIn(shared.email, b.slug))).clinicSlug).toBe(b.slug);
    });

    it("still answers 409 when the person is already on this team, invited or a member", async () => {
      const shared = await colleague(a);
      const invited = await createStaffMember(b.ownerContext, { name: "Shared", email: shared.email, role: "receptionist" });
      expect(await rejection(createStaffMember(b.ownerContext, { name: "Shared", email: shared.email, role: "receptionist" }))).toMatchObject({ status: 409, code: "email_taken" });
      await acceptLoginInvite(shared.userId, invited.membershipId);
      expect(await rejection(createStaffMember(b.ownerContext, { name: "Shared", email: shared.email, role: "receptionist" }))).toMatchObject({ status: 409, code: "email_taken" });
      expect(await rejection(createStaffMember(a.ownerContext, { name: "Shared", email: shared.email, role: "receptionist" }))).toMatchObject({ status: 409, code: "email_taken" });
    });

    it("answers the same for a login nobody works with yet: an unaccepted invite elsewhere, or an account with no business", async () => {
      const pendingEmail = address("pending");
      await createStaffMember(a.ownerContext, { name: "Pending", email: pendingEmail, role: "receptionist" });
      const pending = await createStaffMember(b.ownerContext, { name: "Pending", email: pendingEmail, role: "receptionist" });
      expect(pending.invite.url).toContain("invite=1");

      const strayEmail = address("stray");
      const strayId = randomUUID();
      await owner`insert into auth_users (id, name, email, email_verified, password_set_at) values (${strayId}, 'Stray', ${strayEmail}, true, now())`;
      const stray = await createStaffMember(b.ownerContext, { name: "Stray", email: strayEmail, role: "receptionist" });
      expect(await listMyInvites(strayId)).toEqual([{ id: stray.membershipId, businessName: "Beta Clinic", role: "receptionist", invitedAt: expect.any(String) }]);
      expect(await usersWithEmail(strayEmail)).toBe(1);
    });

    it("links a doctor's login to B's profile only once the doctor accepts", async () => {
      // Dr Imran has a login at A, with his own profile there.
      const doctorEmail = address("imran");
      const [location] = await owner<{ id: string }[]>`select id from locations where tenant_id = ${a.id} limit 1`;
      const [service] = await owner<{ id: string }[]>`select id from services where tenant_id = ${a.id} limit 1`;
      const home = await createStaffPractitioner(a.ownerContext, staffCreatePractitionerSchema.parse({
        name: "Dr Imran Ali", title: "Doctor", specialty: "Paediatrics", email: doctorEmail,
        locationIds: [location!.id], serviceIds: [service!.id], hours: { days: [1, 2, 3, 4, 5], startsAtLocal: "09:00", endsAtLocal: "17:00" },
      }));
      await activate(home.userId);
      // B already lists him as a doctor with no login, as an import would leave it.
      const [profile] = await owner<{ id: string }[]>`
        insert into practitioners (tenant_id, name, title, initials, specialty) values (${b.id}, 'Dr Imran Ali', 'Doctor', 'IA', 'Paediatrics') returning id`;

      const result = await invitePractitionerLogin(b.ownerContext, profile!.id, doctorEmail);

      expect(result.invite.url).toContain("invite=1");
      expect(await usersWithEmail(doctorEmail)).toBe(1);
      const linkOf = async () => (await owner<{ auth_user_id: string | null }[]>`select auth_user_id from practitioners where id = ${profile!.id}`)[0]!.auth_user_id;
      expect(await linkOf()).toBeNull();
      expect(await membershipIn(b.id, home.userId)).toBeUndefined();
      // The team list already shows the profile as taken, as it would for a new doctor's invite.
      expect((await getStaffSnapshot(b.ownerContext)).team.find((member) => member.membershipId === result.membershipId)?.practitionerId).toBe(profile!.id);
      expect(await rejection(invitePractitionerLogin(b.ownerContext, profile!.id, address("other")))).toMatchObject({ status: 409, code: "already_has_login" });

      await acceptLoginInvite(home.userId, result.membershipId);
      expect(await linkOf()).toBe(home.userId);
      expect((await membershipIn(b.id, home.userId))?.role).toBe("practitioner");
    });
  });

  describe("the person's answer", () => {
    const route = (handler: typeof acceptRoute, inviteId: string, signedIn?: Headers) => handler(
      new Request(`http://localhost/api/staff/invites/${inviteId}/x`, { method: "POST", headers: new Headers({ "content-type": "application/json", cookie: signedIn?.get("cookie") ?? "" }), body: "{}" }),
      { params: Promise.resolve({ id: inviteId }) },
    );

    it("shows the invite only to its login, and accepting opens B", async () => {
      const shared = await colleague(a);
      const bystander = await colleague(a);
      const invited = await createStaffMember(b.ownerContext, { name: "Shared", email: shared.email, role: "billing" });

      expect(await listMyInvites(shared.userId)).toEqual([{ id: invited.membershipId, businessName: "Beta Clinic", role: "billing", invitedAt: expect.any(String) }]);
      expect(await listMyInvites(bystander.userId)).toEqual([]);
      // Someone else's session, or none, can't answer it.
      expect((await route(acceptRoute, invited.membershipId, await signIn(bystander.email))).status).toBe(404);
      expect((await route(acceptRoute, invited.membershipId)).status).toBe(401);
      expect((await route(declineRoute, invited.membershipId, await signIn(bystander.email))).status).toBe(404);

      const accepted = await route(acceptRoute, invited.membershipId, await signIn(shared.email));
      expect(accepted.status).toBe(200);
      expect(accepted.headers.getSetCookie().join(";")).toContain(`${activeBusinessCookie}=${b.slug}`);
      expect(await listMyInvites(shared.userId)).toEqual([]);
      expect((await getStaffContext(await signIn(shared.email, b.slug))).role).toBe("billing");
      // Once answered it is gone.
      expect((await route(acceptRoute, invited.membershipId, await signIn(shared.email))).status).toBe(404);
    });

    it("hides a declined invite from the person and tells B nothing; a resend asks again", async () => {
      const shared = await colleague(a);
      const invited = await createStaffMember(b.ownerContext, { name: "Shared", email: shared.email, role: "billing" });
      const teamRow = async () => (await getStaffSnapshot(b.ownerContext)).team.find((member) => member.membershipId === invited.membershipId);
      const auditCount = async () => (await owner<{ n: number }[]>`select count(*)::int as n from audit_events where tenant_id = ${b.id}`)[0]!.n;
      const rowBefore = await teamRow();
      const auditsBefore = await auditCount();

      expect((await route(declineRoute, invited.membershipId, await signIn(shared.email))).status).toBe(200);

      expect(await listMyInvites(shared.userId)).toEqual([]);
      expect(await teamRow()).toEqual(rowBefore);
      expect(await auditCount()).toBe(auditsBefore);
      expect(await rejection(acceptLoginInvite(shared.userId, invited.membershipId))).toMatchObject({ status: 404, code: "invite_not_found" });
      expect(await membershipIn(b.id, shared.userId)).toBeUndefined();

      const resent = await sendMemberAccessLink(b.ownerContext, invited.membershipId);
      expect(resent).toMatchObject({ kind: "invite" });
      expect((await listMyInvites(shared.userId)).map((invite) => invite.id)).toEqual([invited.membershipId]);
    });

    it("can't accept an invite that expired or that B switched off", async () => {
      const shared = await colleague(a);
      const invited = await createStaffMember(b.ownerContext, { name: "Shared", email: shared.email, role: "billing" });
      await owner`update staff_login_invites set expires_at = now() - interval '1 minute' where id = ${invited.membershipId}`;
      expect(await listMyInvites(shared.userId)).toEqual([]);
      expect(await rejection(acceptLoginInvite(shared.userId, invited.membershipId))).toMatchObject({ status: 404 });

      await owner`update staff_login_invites set expires_at = now() + interval '1 day', is_active = false where id = ${invited.membershipId}`;
      expect(await listMyInvites(shared.userId)).toEqual([]);
      expect(await rejection(acceptLoginInvite(shared.userId, invited.membershipId))).toMatchObject({ status: 404 });
    });
  });

  describe("what B may do to an invite it sent", () => {
    it("cancels it as it would a new person's invite, and never touches the login", async () => {
      const shared = await colleague(a);
      const invited = await createStaffMember(b.ownerContext, { name: "Shared", email: shared.email, role: "billing" });
      const brandNew = await createStaffMember(b.ownerContext, { name: "New", email: address("new"), role: "billing" });

      const removedInvite = await removeStaffMember(b.ownerContext, invited.membershipId);
      const removedNew = await removeStaffMember(b.ownerContext, brandNew.membershipId);

      expect(removedInvite.loginDeleted).toBe(removedNew.loginDeleted);
      expect(await usersWithEmail(shared.email)).toBe(1);
      expect(await listMyInvites(shared.userId)).toEqual([]);
      expect((await getStaffContext(await signIn(shared.email))).clinicSlug).toBe(a.slug);
    });

    it("turns it into a new person's invite when B changes the email, leaving the login as it was", async () => {
      const shared = await colleague(a);
      const invited = await createStaffMember(b.ownerContext, { name: "Shared", email: shared.email, role: "billing" });
      const newEmail = address("moved");

      await changeMemberEmail(b.ownerContext, invited.membershipId, { newEmail });

      const [login] = await owner<{ email: string }[]>`select email from auth_users where id = ${shared.userId}`;
      expect(login!.email).toBe(shared.email);
      expect(await listMyInvites(shared.userId)).toEqual([]);
      const row = (await getStaffSnapshot(b.ownerContext)).team.find((member) => member.membershipId === invited.membershipId);
      // The user id B saw for the invite stays the same, as it would for a new person.
      expect(row).toMatchObject({ email: newEmail, invitePending: true, userId: invited.userId });
    });
  });

  describe("which business opens", () => {
    it("opens the first business with no preference, the remembered one with a cookie, and the named one over the cookie", async () => {
      const shared = await colleague(a);
      await join(b, shared);
      const plain = await signIn(shared.email);
      const remembered = await signIn(shared.email, b.slug);

      expect((await getStaffContext(plain)).clinicSlug).toBe(a.slug);
      const inB = await getStaffContext(remembered);
      expect(inB.clinicSlug).toBe(b.slug);
      expect(inB.role).toBe("billing");
      // The business named by the URL or the caller beats the cookie.
      expect((await getStaffContext(remembered, a.slug)).clinicSlug).toBe(a.slug);
      // A named business they are not in is refused, never replaced by another one.
      await expect(getStaffContext(remembered, c.slug)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    });

    it("ignores a cookie for a business the person is not in, and one that is not well formed", async () => {
      const shared = await colleague(a);
      await join(b, shared);
      expect((await getStaffContext(await signIn(shared.email, c.slug))).clinicSlug).toBe(a.slug);
      expect((await getStaffContext(await signIn(shared.email, "NOT a slug!"))).clinicSlug).toBe(a.slug);
      expect((await getStaffContext(await signIn(shared.email, "no-such-business"))).clinicSlug).toBe(a.slug);
    });

    it("sets the cookie through the switch route only for a business the person is in", async () => {
      const shared = await colleague(a);
      await join(b, shared);
      const headers = await signIn(shared.email);
      const post = (slug: string, signedIn = headers) => switchBusiness(new Request("http://localhost/api/staff/business/switch", {
        method: "POST", headers: new Headers({ "content-type": "application/json", cookie: signedIn.get("cookie") ?? "" }), body: JSON.stringify({ slug }),
      }));

      const ok = await post(b.slug);
      expect(ok.status).toBe(200);
      const setCookie = ok.headers.getSetCookie().join(";");
      expect(setCookie).toContain(`${activeBusinessCookie}=${b.slug}`);
      expect(setCookie.toLowerCase()).toContain("httponly");
      expect(setCookie.toLowerCase()).toContain("samesite=lax");
      expect((await post(c.slug)).status).toBe(403);
      expect((await post("Bad Slug")).status).toBe(400);
      expect((await switchBusiness(new Request("http://localhost/api/staff/business/switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: b.slug }) }))).status).toBe(401);
    });

    it("lets a business that asks for a second factor block only itself", async () => {
      const shared = await colleague(a);
      await join(b, shared);
      await owner`update tenants set security_policy = '{"requireSecondFactorForAll": true}'::jsonb where id = ${a.id}`;
      try {
        const headers = await signIn(shared.email);
        await expect(getStaffContext(headers)).rejects.toMatchObject({ code: "second_factor_required" });
        // Alpha is first, so it is refused; Beta, chosen by cookie or by name, opens.
        const inB = new Headers({ cookie: `${headers.get("cookie")}; ${activeBusinessCookie}=${b.slug}` });
        expect((await getStaffContext(inB)).clinicSlug).toBe(b.slug);
        expect((await getStaffContext(headers, b.slug)).clinicSlug).toBe(b.slug);
        // The switch route does not run the policy of the business being left.
        const switched = await switchBusiness(new Request("http://localhost/api/staff/business/switch", {
          method: "POST", headers: new Headers({ "content-type": "application/json", cookie: headers.get("cookie") ?? "" }), body: JSON.stringify({ slug: b.slug }),
        }));
        expect(switched.status).toBe(200);
      } finally {
        await owner`update tenants set security_policy = '{}'::jsonb where id = ${a.id}`;
      }
    });
  });

  describe("what a business may do to a shared login", () => {
    it("refuses a manager changing the email or sending a password link for a person who also works elsewhere", async () => {
      const shared = await colleague(a);
      const added = await join(b, shared);

      for (const [context, membershipId] of [[b.ownerContext, added.membershipId], [a.ownerContext, shared.membershipId]] as const) {
        expect(await rejection(changeMemberEmail(context, membershipId, { newEmail: address("hijack") }))).toMatchObject({ status: 409, code: "shared_login" });
        expect(await rejection(sendMemberAccessLink(context, membershipId))).toMatchObject({ status: 409, code: "shared_login" });
      }
      const [row] = await owner<{ email: string }[]>`select email from auth_users where id = ${shared.userId}`;
      expect(row!.email).toBe(shared.email);
    });

    it("shows only a neutral 'works elsewhere' flag on the team list, with no business name", async () => {
      const shared = await colleague(a);
      const solo = await colleague(b);
      await join(b, shared);

      const team = (await getStaffSnapshot(b.ownerContext)).team;
      expect(team.find((member) => member.userId === shared.userId)?.worksElsewhere).toBe(true);
      expect(team.find((member) => member.userId === solo.userId)?.worksElsewhere).toBeUndefined();
      expect(JSON.stringify(team)).not.toContain("Alpha Clinic");
    });
  });

  describe("leaving one business", () => {
    it("keeps the login and the other membership when B removes the person, and never lands them in B again", async () => {
      const shared = await colleague(a);
      const added = await join(b, shared);
      const before = await signIn(shared.email, b.slug);
      expect((await getStaffContext(before)).clinicSlug).toBe(b.slug);

      const removal = await removeStaffMember(b.ownerContext, added.membershipId);

      expect(removal.loginDeleted).toBe(false);
      expect(await usersWithEmail(shared.email)).toBe(1);
      const [remaining] = await owner<{ n: number }[]>`select count(*)::int as n from memberships where user_id = ${shared.userId}`;
      expect(remaining!.n).toBe(1);
      // B can't end sessions that A also relies on, so the person stays signed in; their next request to B is refused, and the old cookie for B lands in A.
      const [sessions] = await owner<{ n: number }[]>`select count(*)::int as n from auth_sessions where user_id = ${shared.userId}`;
      expect(sessions!.n).toBeGreaterThan(0);
      // The session that was open in B keeps working, but B itself is closed to it at once: access is re-read on every request.
      await expect(getStaffContext(before, b.slug)).rejects.toMatchObject({ status: 403 });
      expect((await getStaffContext(before)).clinicSlug).toBe(a.slug);
      const again = await signIn(shared.email, b.slug);
      expect((await getStaffContext(again)).clinicSlug).toBe(a.slug);
      await expect(getStaffContext(again, b.slug)).rejects.toMatchObject({ status: 403 });
    });

    it("lands on the other business when B switches the person off", async () => {
      const shared = await colleague(a);
      const added = await join(b, shared);
      await owner`update memberships set is_active = false where id = ${added.membershipId}`;
      expect((await getStaffContext(await signIn(shared.email, b.slug))).clinicSlug).toBe(a.slug);
    });
  });
});
