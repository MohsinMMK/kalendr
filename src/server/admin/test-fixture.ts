/**
 * Shared set-up for the platform admin integration tests: people who really sign in through Better Auth, an operator
 * list kept through the owner connection, and the guard that keeps these tests on an isolated local server.
 */
import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";
import postgres from "postgres";

import { auth } from "@/lib/auth";
import { markSecondFactor } from "@/server/staff-security";

export const runtimeUrl = process.env.DATABASE_URL;
export const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
export const workerUrl = process.env.WORKER_DATABASE_URL;

const isLocal = (url: string | undefined) => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && ["5544", "5545", "5601", "5609"].includes(parsed.port);
};
export const localDatabaseReady = isLocal(runtimeUrl) && isLocal(ownerUrl) && process.env.KALENDR_PREVIEW_MODE === "false";

export const password = `Pw-${randomUUID()}`;
export const suffix = randomUUID().slice(0, 8);

export interface Person { id: string; email: string; name: string }
export interface SignedIn { headers: Headers; token: string }

export class Fixture {
  private connection: postgres.Sql | null = null;

  /** Opened on first use, so a skipped suite (no local database) never needs the owner URL. */
  get owner(): postgres.Sql {
    if (!this.connection) {
      if (!ownerUrl) throw new Error("KALENDR_TEST_OWNER_URL is required");
      this.connection = postgres(ownerUrl, { max: 1, prepare: false, onnotice: () => {} });
    }
    return this.connection;
  }

  async tenant(label: string): Promise<{ id: string; slug: string }> {
    const slug = `${label}-${suffix}`;
    const [row] = await this.owner<{ id: string }[]>`
      insert into tenants (slug, name, legal_name, phone, email, timezone)
      values (${slug}, ${`Business ${label}`}, ${`Business ${label}`}, '+919000000998', ${`${slug}@example.com`}, 'Asia/Kolkata')
      returning id`;
    if (!row) throw new Error("tenant not created");
    // The billing lane starts a trial on first read; seeding the row keeps these tests about the admin console only.
    await this.owner`
      insert into tenant_subscriptions (tenant_id, plan_key, status, trial_ends_at) values (${row.id}, 'growth', 'trialing', now() + interval '14 days')
      on conflict (tenant_id) do nothing`.catch(() => undefined);
    return { id: row.id, slug };
  }

  async person(label: string, options: { tenantId?: string; role?: string; verified?: boolean } = {}): Promise<Person> {
    const id = randomUUID();
    const email = `${label}.${suffix}.${id.slice(0, 4)}@example.com`;
    const name = `Person ${label} ${id.slice(0, 4)}`;
    await this.owner`insert into auth_users (id, name, email, email_verified, password_set_at) values (${id}, ${name}, ${email}, ${options.verified ?? true}, now())`;
    await this.owner`insert into auth_accounts (id, issuer, account_id, provider_id, user_id, password) values (${randomUUID()}, 'local:credential', ${id}, 'credential', ${id}, ${await hashPassword(password)})`;
    if (options.tenantId) {
      await this.owner`insert into memberships (tenant_id, user_id, role, is_active) values (${options.tenantId}, ${id}, ${options.role ?? "owner"}::membership_role, true)`;
    }
    return { id, email, name };
  }

  async makeOperator(user: Person, role: "support" | "billing" | "super"): Promise<void> {
    await this.owner`insert into platform_admins (user_id, role, is_active) values (${user.id}, ${role}, true)`;
  }

  async signIn(user: Person): Promise<SignedIn> {
    const response = await auth.api.signInEmail({ body: { email: user.email, password }, asResponse: true });
    const cookies = response.headers.getSetCookie().map((line) => line.split(";")[0] ?? "");
    const token = decodeURIComponent((cookies.find((line) => line.includes("session_token")) ?? "").split("=")[1] ?? "").split(".")[0] ?? "";
    return { headers: new Headers({ cookie: cookies.join("; ") }), token };
  }

  /** Signs in, enrols an authenticator the way the sign-in screens leave the database, and passes the code check. */
  async signInWithSecondFactor(user: Person, hoursAgo = 0): Promise<SignedIn> {
    const session = await this.signIn(user);
    await this.owner`update auth_users set two_factor_enabled = true where id = ${user.id}`;
    await markSecondFactor(session.token);
    if (hoursAgo > 0) await this.owner`update auth_sessions set second_factor_at = now() - make_interval(hours => ${hoursAgo}) where token = ${session.token}`;
    return session;
  }

  async end(): Promise<void> {
    await this.connection?.end();
  }
}

/** The same headers plus one extra cookie, as a browser holding the impersonation cookie sends them. */
export function withCookie(session: SignedIn, name: string, value: string, extra: Record<string, string> = {}): Headers {
  const headers = new Headers(session.headers);
  headers.set("cookie", `${headers.get("cookie") ?? ""}; ${name}=${value}`);
  for (const [key, entry] of Object.entries(extra)) headers.set(key, entry);
  return headers;
}
