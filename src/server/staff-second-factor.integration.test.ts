/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { auth } from "@/lib/auth";
import { ApiError } from "@/server/api-error";
import { getStaffContext, requireRecentStepUp } from "@/server/staff-context";
import { markSecondFactor } from "@/server/staff-security";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
// Only an isolated local server (5544, 5545, 5609, or the shared builders' server on 5601), never a real database.
const isLocal = (url: string | undefined) => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && ["5544", "5545", "5601", "5609"].includes(parsed.port);
};
const describeLocal = isLocal(runtimeUrl) && isLocal(ownerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

const password = `Pw-${randomUUID()}`;

describeLocal("staff second factor, per sign-in", () => {
  let owner: postgres.Sql;
  let tenantId = "";
  const suffix = randomUUID().slice(0, 8);

  async function person(role: string, options: { member?: boolean; active?: boolean } = {}): Promise<{ id: string; email: string }> {
    const id = randomUUID();
    const email = `${role}.${suffix}.${id.slice(0, 4)}@example.com`;
    await owner`insert into auth_users (id, name, email, email_verified, password_set_at) values (${id}, ${`Test ${role}`}, ${email}, true, now())`;
    await owner`insert into auth_accounts (id, issuer, account_id, provider_id, user_id, password) values (${randomUUID()}, 'local:credential', ${id}, 'credential', ${id}, ${await hashPassword(password)})`;
    if (options.member !== false) {
      await owner`insert into memberships (tenant_id, user_id, role, is_active) values (${tenantId}, ${id}, ${role}::membership_role, ${options.active ?? true})`;
    }
    return { id, email };
  }

  async function signIn(email: string): Promise<{ headers: Headers; token: string }> {
    const response = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    const cookies = response.headers.getSetCookie().map((line) => line.split(";")[0]!);
    const token = decodeURIComponent((cookies.find((line) => line.includes("session_token")) ?? "").split("=")[1] ?? "").split(".")[0] ?? "";
    return { headers: new Headers({ cookie: cookies.join("; ") }), token };
  }

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const [tenant] = await owner<{ id: string }[]>`
      insert into tenants (slug, name, legal_name, phone, email, timezone)
      values (${`second-factor-${suffix}`}, 'Second Factor Test', 'Second Factor Test', '+919000000999', ${`sf-${suffix}@example.com`}, 'Asia/Kolkata')
      returning id`;
    tenantId = tenant!.id;
  });

  afterAll(async () => {
    await owner.end();
  });

  it("lets a receptionist with no factor in, because their role does not need one", async () => {
    const receptionist = await person("receptionist");
    const { headers } = await signIn(receptionist.email);
    const context = await getStaffContext(headers);
    expect(context.role).toBe("receptionist");
    expect(context.secondFactorEnrolled).toBe(false);
  });

  it("takes an owner without a second factor to enrolment before any data", async () => {
    const boss = await person("owner");
    const { headers } = await signIn(boss.email);
    await expect(getStaffContext(headers)).rejects.toMatchObject({ code: "second_factor_required", status: 403 });
  });

  it("asks everyone when the business policy says so", async () => {
    await owner`update tenants set security_policy = '{"requireSecondFactorForAll": true}'::jsonb where id = ${tenantId}`;
    try {
      const receptionist = await person("receptionist");
      const { headers } = await signIn(receptionist.email);
      await expect(getStaffContext(headers)).rejects.toMatchObject({ code: "second_factor_required" });
    } finally {
      await owner`update tenants set security_policy = '{}'::jsonb where id = ${tenantId}`;
    }
  });

  it("asks for the code when a person with a factor signed in another way, then accepts it and times step-up from it", async () => {
    const admin = await person("admin");
    const { headers, token } = await signIn(admin.email);
    // The same state a Google, Microsoft or magic-link sign-in leaves behind for someone who has an authenticator app.
    await owner`update auth_users set two_factor_enabled = true where id = ${admin.id}`;
    await expect(getStaffContext(headers)).rejects.toMatchObject({ code: "second_factor_pending" });

    await markSecondFactor(token);
    const context = await getStaffContext(headers);
    expect(context.secondFactorAt).toBeInstanceOf(Date);
    expect(() => requireRecentStepUp(context)).not.toThrow();

    // Eleven minutes later the same session is asked again.
    await owner`update auth_sessions set second_factor_at = now() - interval '11 minutes' where token = ${token}`;
    const stale = await getStaffContext(headers);
    expect(() => requireRecentStepUp(stale)).toThrow(ApiError);
    expect(() => requireRecentStepUp(stale)).toThrow(/code from your authenticator/);
    await owner`update auth_sessions set second_factor_at = now() - interval '9 minutes' where token = ${token}`;
    const fresh = await getStaffContext(headers);
    expect(() => requireRecentStepUp(fresh)).not.toThrow();
  });

  it("counts a passkey as a second factor for the enrolment rule", async () => {
    const boss = await person("owner");
    await owner`insert into auth_passkeys (user_id, name, public_key, credential_id, counter, device_type, backed_up) values (${boss.id}, 'Phone', 'key', ${randomUUID()}, 0, 'multiDevice', true)`;
    const { headers, token } = await signIn(boss.email);
    // Enrolled, but this sign-in has not used it yet.
    await expect(getStaffContext(headers)).rejects.toMatchObject({ code: "second_factor_pending" });
    await markSecondFactor(token);
    await expect(getStaffContext(headers)).resolves.toMatchObject({ secondFactorEnrolled: true });
  });

  it("gives no session to someone without an active membership", async () => {
    const stranger = await person("receptionist", { member: false });
    expect((await signIn(stranger.email)).token).toBe("");
    const [{ count }] = await owner<{ count: number }[]>`select count(*)::int as count from auth_sessions where user_id = ${stranger.id}`;
    expect(count).toBe(0);

    const former = await person("receptionist", { active: false });
    expect((await signIn(former.email)).token).toBe("");
    const [{ count: formerSessions }] = await owner<{ count: number }[]>`select count(*)::int as count from auth_sessions where user_id = ${former.id}`;
    expect(formerSessions).toBe(0);
  });

  it("creates no user for an unknown email asking for a sign-in link or arriving through a provider", async () => {
    const before = await owner<{ count: number }[]>`select count(*)::int as count from auth_users`;
    const email = `nobody.${suffix}@example.com`;
    await auth.api.signInMagicLink({ body: { email }, headers: new Headers() }).catch(() => undefined);
    const after = await owner<{ count: number }[]>`select count(*)::int as count from auth_users`;
    expect(after[0]!.count).toBe(before[0]!.count);
    const [found] = await owner<{ count: number }[]>`select count(*)::int as count from auth_users where email = ${email}`;
    expect(found!.count).toBe(0);
  });

  it("ends a device's session at once when it is removed", async () => {
    const receptionist = await person("receptionist");
    const first = await signIn(receptionist.email);
    const second = await signIn(receptionist.email);
    await expect(getStaffContext(first.headers)).resolves.toBeTruthy();
    await auth.api.revokeSession({ body: { token: first.token }, headers: second.headers });
    await expect(getStaffContext(first.headers)).rejects.toMatchObject({ status: 401 });
    await expect(getStaffContext(second.headers)).resolves.toBeTruthy();
  });
});
