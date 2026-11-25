/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
// The confirmation link is the one email sent inside the request; the test reads it here instead of from a mailbox.
const confirmations: Array<{ email: string; url: string }> = [];
vi.mock("@/server/auth-email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth-email")>()),
  sendEmailChangeConfirmation: async (input: { email: string; url: string }) => { confirmations.push({ email: input.email, url: input.url }); return true; },
}));

import { auth } from "@/lib/auth";
import { resolvePermissions, type StaffRole } from "@/lib/permissions";
import { ACCOUNT_EMAIL_NOTICE_EVENT, ACCOUNT_EMAIL_NOTICE_PURPOSE, accountEmailNoticeSecretSchema } from "@/lib/staff-email";
import { clinicRegistrationSchema, registerClinic } from "@/server/clinic-registration";
import { openPrivate } from "@/server/messaging/sealed-link";
import type { StaffContext } from "@/server/staff-context";
import { markSecondFactor } from "@/server/staff-security";
import { changeMemberEmail } from "@/server/staff-email";
import { createStaffMember } from "@/server/staff-team";
import { accountEmailNoticeHandler } from "@/worker/handlers/account-email-notice";
import { isLocalDatabase } from "@/test/billing-fixture";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const describeLocal = isLocalDatabase(runtimeUrl) && isLocalDatabase(ownerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

const password = `Pw-${randomUUID()}`;

describeLocal("changing a staff sign-in email", () => {
  let owner: postgres.Sql;
  const created: string[] = [];
  const suffix = randomUUID().slice(0, 6);
  let tenantId = "";
  let otherTenantId = "";
  let ownerContext: StaffContext;
  let adminContext: StaffContext;
  let ownerEmail = "";

  const address = (label: string) => `${label}-${suffix}-${randomUUID().slice(0, 4)}@example.com`;

  function contextFor(base: StaffContext, role: StaffRole, userId: string, email: string, patch: Partial<StaffContext> = {}): StaffContext {
    return { ...base, role, permissions: resolvePermissions(role, {}), membershipId: null, userId, userName: `Test ${role}`, userEmail: email, ...patch };
  }

  async function register(label: string): Promise<{ id: string; ownerUserId: string; context: StaffContext; email: string }> {
    const slug = `email-${label}-${suffix}`;
    const email = address(`own-${label}`);
    const registered = await registerClinic(clinicRegistrationSchema.parse({
      template: "general_practice", clinicName: "Email Change Clinic", slug, ownerName: "Asha Rao", email, password, timezone: "Asia/Kolkata",
      ownerPractices: false,
    }));
    created.push(registered.tenantId);
    const [member] = await owner<{ user_id: string }[]>`select user_id from memberships where tenant_id = ${registered.tenantId}`;
    return {
      id: registered.tenantId, ownerUserId: member!.user_id, email,
      context: {
        tenantId: registered.tenantId, clinicSlug: slug, clinicName: registered.clinicName, role: "owner", permissions: resolvePermissions("owner", {}),
        membershipId: null, userId: member!.user_id, userName: "Asha Rao", userEmail: email, secondFactorEnrolled: true, secondFactorAt: new Date(), preview: false,
      },
    };
  }

  /** A signed-in person who has chosen a password, with a membership in the first business. */
  async function person(role: Exclude<StaffRole, "owner">, options: { tenant?: string } = {}): Promise<{ id: string; email: string }> {
    const id = randomUUID();
    const email = address(role);
    await owner`insert into auth_users (id, name, email, email_verified, password_set_at) values (${id}, ${`Test ${role}`}, ${email}, true, now())`;
    await owner`insert into auth_accounts (id, issuer, account_id, provider_id, user_id, password) values (${randomUUID()}, 'local:credential', ${id}, 'credential', ${id}, ${await hashPassword(password)})`;
    await owner`insert into memberships (tenant_id, user_id, role) values (${options.tenant ?? tenantId}, ${id}, ${role}::membership_role)`;
    return { id, email };
  }

  async function membershipOf(userId: string, tenant = tenantId): Promise<string> {
    const [row] = await owner<{ id: string }[]>`select id from memberships where tenant_id = ${tenant} and user_id = ${userId}`;
    return row!.id;
  }

  async function signIn(email: string): Promise<{ headers: Headers; token: string }> {
    const response = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    const cookies = response.headers.getSetCookie().map((line) => line.split(";")[0]!);
    const token = decodeURIComponent((cookies.find((line) => line.includes("session_token")) ?? "").split("=")[1] ?? "").split(".")[0] ?? "";
    return { headers: new Headers({ cookie: cookies.join("; ") }), token };
  }

  const emailOf = async (userId: string): Promise<{ email: string; verified: boolean }> => {
    const [row] = await owner<{ email: string; email_verified: boolean }[]>`select email, email_verified from auth_users where id = ${userId}`;
    return { email: row!.email, verified: row!.email_verified };
  };

  /** The addresses the queued notices will go to, opened the way the worker opens them, by kind. */
  async function notices(tenant = tenantId): Promise<Array<{ kind: string; to: string; id: string }>> {
    const rows = await owner<{ id: string; payload: { kind: string; sealed: string } }[]>`
      select id, aggregate_id as "aggregateId", payload from outbox_events where tenant_id = ${tenant} and event_type = ${ACCOUNT_EMAIL_NOTICE_EVENT} order by created_at`;
    return rows.map((row) => {
      const opened = openPrivate(ACCOUNT_EMAIL_NOTICE_PURPOSE, tenant, (row as unknown as { aggregateId: string }).aggregateId, row.payload.sealed);
      return { kind: row.payload.kind, to: accountEmailNoticeSecretSchema.parse(JSON.parse(opened ?? "{}")).email, id: row.id };
    });
  }

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const first = await register("a");
    tenantId = first.id;
    ownerContext = first.context;
    ownerEmail = first.email;
    otherTenantId = (await register("b")).id;
    const admin = await person("admin");
    adminContext = contextFor(ownerContext, "admin", admin.id, admin.email);
  });

  afterAll(async () => {
    for (const id of created) {
      await owner`delete from outbox_events where tenant_id = ${id}`.catch(() => undefined);
      await owner`update tenants set is_active = false where id = ${id}`.catch(() => undefined);
    }
    await owner.end();
  });

  describe("an owner or admin changing a teammate's email", () => {
    it("moves the email, signs the person out, kills old links, unlinks old logins, and tells both addresses through the outbox", async () => {
      const member = await person("receptionist");
      const memberId = await membershipOf(member.id);
      await signIn(member.email);
      await owner`insert into auth_verifications (id, identifier, value, expires_at) values (${randomUUID()}, ${`reset-${randomUUID()}`}, ${member.id}, now() + interval '1 hour')`;
      await owner`insert into auth_accounts (id, issuer, account_id, provider_id, user_id) values (${randomUUID()}, 'google', ${`g-${randomUUID()}`}, 'google', ${member.id})`;
      const before = (await notices()).length;
      const newEmail = address("new");

      const result = await changeMemberEmail(ownerContext, memberId, { newEmail: ` ${newEmail.toUpperCase()}`.trim().toLowerCase() });
      expect(result).toEqual({ membershipId: memberId, inviteReissued: false });

      // Not verified: the manager typed it, the person has not proved it.
      expect(await emailOf(member.id)).toEqual({ email: newEmail, verified: false });
      const [sessions] = await owner<{ count: number }[]>`select count(*)::int as count from auth_sessions where user_id = ${member.id}`;
      expect(sessions!.count).toBe(0);
      const [links] = await owner<{ count: number }[]>`select count(*)::int as count from auth_verifications where value = ${member.id}`;
      expect(links!.count).toBe(0);
      const [social] = await owner<{ count: number }[]>`select count(*)::int as count from auth_accounts where user_id = ${member.id} and provider_id <> 'credential'`;
      expect(social!.count).toBe(0);

      const fresh = (await notices()).slice(before);
      expect(fresh.map((entry) => [entry.kind, entry.to]).sort()).toEqual([["changed_by_admin", member.email], ["now_yours", newEmail]].sort());
      // No readable address anywhere in the outbox rows or the audit trail.
      const rows = await owner<{ payload: unknown; aggregate_id: string; dedupe_key: string }[]>`select payload, aggregate_id, dedupe_key from outbox_events where id = any(${fresh.map((entry) => entry.id)})`;
      for (const text of [JSON.stringify(rows), JSON.stringify(await owner`select metadata, action from audit_events where tenant_id = ${tenantId} and action = 'staff.member.email_changed'`)]) {
        expect(text).not.toContain(member.email.split("@")[0]);
        expect(text).not.toContain(newEmail.split("@")[0]);
        expect(text).not.toContain("Test receptionist");
      }
      const [audit] = await owner<{ metadata: Record<string, unknown>; actor_user_id: string }[]>`
        select metadata, actor_user_id from audit_events where tenant_id = ${tenantId} and action = 'staff.member.email_changed' order by occurred_at desc limit 1`;
      expect(audit!.metadata).toEqual({ membershipId: memberId, inviteReissued: false, unlinkedLogins: 1 });
      expect(audit!.actor_user_id).toBe(ownerContext.userId);

      // The old link and sign-in no longer work for the old address, and the person can sign in with the new one only.
      await expect(auth.api.signInEmail({ body: { email: member.email, password } })).rejects.toBeDefined();
      await expect(auth.api.signInEmail({ body: { email: newEmail, password } })).resolves.toBeDefined();
    });

    it("sends a person who has not accepted their invite a new invite at the new address, and the old link dies", async () => {
      const created = await createStaffMember(ownerContext, { name: "Pending Person", email: address("pending"), role: "receptionist" });
      const memberId = created.membershipId;
      const [oldLink] = await owner<{ identifier: string }[]>`select identifier from auth_verifications where value = ${created.userId}`;
      expect(oldLink).toBeDefined();
      const newEmail = address("pending-new");

      const result = await changeMemberEmail(ownerContext, memberId, { newEmail });
      expect(result.inviteReissued).toBe(true);
      expect(result.invite?.url).toMatch(/\/reset-password\?token=.+&invite=1$/);
      const links = await owner<{ identifier: string }[]>`select identifier from auth_verifications where value = ${created.userId}`;
      expect(links).toHaveLength(1);
      expect(links[0]!.identifier).not.toBe(oldLink!.identifier);
      expect((await emailOf(created.userId)).email).toBe(newEmail);
    });

    it("lets an owner change an admin's email, and an admin change a receptionist's", async () => {
      const otherAdmin = await person("admin");
      await changeMemberEmail(ownerContext, await membershipOf(otherAdmin.id), { newEmail: address("admin-new") });
      const receptionist = await person("receptionist");
      await changeMemberEmail(adminContext, await membershipOf(receptionist.id), { newEmail: address("rec-new") });
    });

    it("refuses each thing it should", async () => {
      const receptionist = await person("receptionist");
      const receptionistMembership = await membershipOf(receptionist.id);
      const otherAdmin = await person("admin");
      const ownerMembership = await membershipOf(ownerContext.userId!);
      const newEmail = address("guard");

      // Yourself: use the profile.
      await expect(changeMemberEmail(ownerContext, ownerMembership, { newEmail })).rejects.toMatchObject({ status: 400, code: "own_email" });
      // An admin never on the owner, and only the owner on an admin.
      await expect(changeMemberEmail(adminContext, ownerMembership, { newEmail })).rejects.toMatchObject({ status: 403, code: "owner_required" });
      await expect(changeMemberEmail(adminContext, await membershipOf(otherAdmin.id), { newEmail })).rejects.toMatchObject({ status: 403, code: "owner_only" });
      // Without the team switch.
      const receptionistContext = contextFor(ownerContext, "receptionist", receptionist.id, receptionist.email);
      await expect(changeMemberEmail(receptionistContext, receptionistMembership, { newEmail })).rejects.toMatchObject({ status: 403 });
      // A recent second factor is needed, and a person with none must set one up.
      await expect(changeMemberEmail({ ...ownerContext, secondFactorAt: new Date(Date.now() - 11 * 60_000) }, receptionistMembership, { newEmail })).rejects.toMatchObject({ code: "step_up_required" });
      await expect(changeMemberEmail({ ...ownerContext, secondFactorAt: null }, receptionistMembership, { newEmail })).rejects.toMatchObject({ code: "step_up_required" });
      await expect(changeMemberEmail({ ...ownerContext, secondFactorEnrolled: false }, receptionistMembership, { newEmail })).rejects.toMatchObject({ code: "second_factor_required" });
      // Same address, a taken address, a deactivated person.
      await expect(changeMemberEmail(ownerContext, receptionistMembership, { newEmail: receptionist.email })).rejects.toMatchObject({ code: "same_email" });
      await expect(changeMemberEmail(ownerContext, receptionistMembership, { newEmail: ownerEmail })).rejects.toMatchObject({ status: 409, code: "email_taken", fieldErrors: { email: expect.any(Array) } });
      await owner`update memberships set is_active = false where id = ${receptionistMembership}`;
      await expect(changeMemberEmail(ownerContext, receptionistMembership, { newEmail })).rejects.toMatchObject({ code: "member_inactive" });
      // Nothing above changed the address or signed anyone out.
      expect((await emailOf(receptionist.id)).email).toBe(receptionist.email);
    });

    it("keeps one business from changing another's people, and refuses a login shared by two businesses", async () => {
      const outsider = await person("receptionist", { tenant: otherTenantId });
      await expect(changeMemberEmail(ownerContext, await membershipOf(outsider.id, otherTenantId), { newEmail: address("x") })).rejects.toMatchObject({ status: 404, code: "member_not_found" });
      const shared = await person("receptionist");
      await owner`insert into memberships (tenant_id, user_id, role) values (${otherTenantId}, ${shared.id}, 'receptionist')`;
      await expect(changeMemberEmail(ownerContext, await membershipOf(shared.id), { newEmail: address("shared") })).rejects.toMatchObject({ status: 409, code: "shared_login" });
      expect((await emailOf(shared.id)).email).toBe(shared.email);
    });

    it("refuses a change from or to a domain that makes everyone use company sign-in", async () => {
      const member = await person("receptionist");
      const domain = `sso-${suffix}.example.org`;
      await owner`insert into verified_domains (tenant_id, domain, token_hash, verified_at, require_sso) values (${tenantId}, ${domain}, 'hash', now(), true)`;
      try {
        await expect(changeMemberEmail(ownerContext, await membershipOf(member.id), { newEmail: `someone@${domain}` })).rejects.toMatchObject({ status: 409, code: "company_sign_in_email" });
      } finally {
        await owner`delete from verified_domains where tenant_id = ${tenantId} and domain = ${domain}`;
      }
    });
  });

  describe("the notice emails the worker sends", () => {
    it("opens the sealed address, sends once to it, and says nothing about the other address", async () => {
      const member = await person("receptionist");
      const newEmail = address("worker-new");
      const before = (await notices()).length;
      await changeMemberEmail(ownerContext, await membershipOf(member.id), { newEmail });
      const queued = (await notices()).slice(before);
      const sent: Array<{ to: string; subject: string; text: string; idempotencyKey?: string }> = [];
      const provider = { send: async (message: { to: string; subject: string; text: string; idempotencyKey?: string }) => { sent.push(message); return { providerMessageId: "x" }; } };
      const handler = accountEmailNoticeHandler({ email: { provider: provider as never, fallbackReplyTo: null } });
      for (const entry of queued) {
        const [row] = await owner<{ id: string; aggregate_id: string; dedupe_key: string; payload: unknown }[]>`select id, aggregate_id, dedupe_key, payload from outbox_events where id = ${entry.id}`;
        const outcome = await owner.begin(async (tenantDb) => {
          await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
          return handler(tenantDb, { id: row!.id, tenantId, aggregateType: "account_email", aggregateId: row!.aggregate_id, eventType: ACCOUNT_EMAIL_NOTICE_EVENT, payload: row!.payload, dedupeKey: row!.dedupe_key, attemptCount: 0 });
        });
        expect(outcome).toBe("delivered");
      }
      expect(sent.map((message) => message.to).sort()).toEqual([member.email, newEmail].sort());
      for (const message of sent) {
        expect(message.text).not.toContain(message.to === newEmail ? member.email : newEmail);
        expect(message.idempotencyKey).toMatch(/^account-email-notice:/);
      }
      expect(sent.find((message) => message.to === member.email)?.subject).toMatch(/changed by your manager/);
    });

    it("dead-letters a payload it cannot open instead of sending", async () => {
      const handler = accountEmailNoticeHandler({ email: { provider: { send: async () => { throw new Error("must not send"); } } as never, fallbackReplyTo: null } });
      const outcome = await owner.begin(async (tenantDb) => {
        await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
        return handler(tenantDb, { id: randomUUID(), tenantId, aggregateType: "account_email", aggregateId: randomUUID(), eventType: ACCOUNT_EMAIL_NOTICE_EVENT, payload: { kind: "changed", sealed: "l1.AAAA" }, dedupeKey: "x", attemptCount: 0 });
      });
      expect(outcome).toEqual({ outcome: "dead", code: "sealed_unreadable" });
    });
  });

  describe("a person changing their own email (Better Auth change-email)", () => {
    it("sends a link to the new address and a heads-up to the old one, and changes nothing until the link is opened", async () => {
      const me = await person("receptionist");
      const { headers } = await signIn(me.email);
      const newEmail = address("mine");
      const before = (await notices()).length;
      confirmations.length = 0;

      await auth.api.changeEmail({ headers, body: { newEmail, callbackURL: "/profile" } });

      expect(confirmations).toHaveLength(1);
      expect(confirmations[0]!.email).toBe(newEmail);
      expect((await emailOf(me.id)).email).toBe(me.email);
      const queued = (await notices()).slice(before);
      expect(queued.map((entry) => [entry.kind, entry.to])).toEqual([["requested", me.email]]);
    });

    it("on opening the link: moves the email (kept verified), signs other devices out, tells the old address once, and a second opening does nothing", async () => {
      const me = await person("receptionist");
      const here = await signIn(me.email);
      await signIn(me.email); // another device
      const newEmail = address("mine2");
      confirmations.length = 0;
      await auth.api.changeEmail({ headers: here.headers, body: { newEmail } });
      const token = new URL(confirmations[0]!.url).searchParams.get("token")!;
      const before = (await notices()).length;

      await auth.api.verifyEmail({ query: { token }, headers: here.headers });

      expect(await emailOf(me.id)).toEqual({ email: newEmail, verified: true });
      const remaining = await owner<{ token: string }[]>`select token from auth_sessions where user_id = ${me.id}`;
      expect(remaining.map((row) => row.token)).toEqual([here.token]);
      const afterOpen = (await notices()).slice(before);
      expect(afterOpen.map((entry) => [entry.kind, entry.to])).toEqual([["changed", me.email]]);
      const audit = await owner<{ action: string; metadata: unknown }[]>`select action, metadata from audit_events where tenant_id = ${tenantId} and actor_user_id = ${me.id} and action like 'staff.email.%' order by occurred_at`;
      expect(audit.map((row) => row.action)).toEqual(["staff.email.change_requested", "staff.email.changed"]);
      expect(JSON.stringify(audit)).not.toContain(me.email.split("@")[0]);

      // The same link again finds the email already moved: nothing more is sent.
      await auth.api.verifyEmail({ query: { token }, headers: here.headers }).catch(() => undefined);
      expect((await notices()).slice(before)).toHaveLength(1);
    });

    it("says clearly that an address is taken, through the door Better Auth itself opens too", async () => {
      const me = await person("receptionist");
      const other = await person("receptionist");
      const { headers } = await signIn(me.email);
      confirmations.length = 0;
      await expect(auth.api.changeEmail({ headers, body: { newEmail: other.email } })).rejects.toMatchObject({ body: { code: "email_taken" } });
      expect(confirmations).toHaveLength(0);
    });

    it("needs a fresh second factor from someone who has one, and none from someone who has none", async () => {
      const me = await person("receptionist");
      const { headers, token } = await signIn(me.email);
      // Enrolled after this sign-in began, so the session has no second-factor time yet (Better Auth would have challenged a fresh sign-in).
      await owner`update auth_users set two_factor_enabled = true where id = ${me.id}`;
      confirmations.length = 0;
      await expect(auth.api.changeEmail({ headers, body: { newEmail: address("2fa") } })).rejects.toMatchObject({ body: { code: "step_up_required" } });
      expect(confirmations).toHaveLength(0);
      await markSecondFactor(token);
      await auth.api.changeEmail({ headers, body: { newEmail: address("2fa") } });
      expect(confirmations).toHaveLength(1);
    });

    it("refuses an address on a company-sign-in domain", async () => {
      const me = await person("receptionist");
      const domain = `own-sso-${suffix}.example.org`;
      await owner`insert into verified_domains (tenant_id, domain, token_hash, verified_at, require_sso) values (${tenantId}, ${domain}, 'hash', now(), true)`;
      try {
        const { headers } = await signIn(me.email);
        await expect(auth.api.changeEmail({ headers, body: { newEmail: `me@${domain}` } })).rejects.toMatchObject({ body: { code: "company_sign_in_email" } });
      } finally {
        await owner`delete from verified_domains where tenant_id = ${tenantId} and domain = ${domain}`;
      }
    });
  });
});
