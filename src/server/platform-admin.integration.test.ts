/** @vitest-environment node */

import { globSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }));

import { withTenant } from "@/db/client";

import { ApiError } from "./api-error";
import { getAdminContext } from "./admin-context";
import { findMessages } from "./admin/messages";
import { listOperators, setOperator } from "./admin/operators";
import { listTenants, tenantHealth } from "./admin/tenants";
import { listAudit } from "./admin/audit";
import { getStaffContext } from "./staff-context";
import { Fixture, localDatabaseReady, runtimeUrl, type Person, type SignedIn } from "./admin/test-fixture";

const describeLocal = localDatabaseReady ? describe : describe.skip;

describeLocal("platform admin: who gets in, and what they can see", () => {
  const fixture = new Fixture();
  let runtime: postgres.Sql;
  let tenantA = { id: "", slug: "" };
  let tenantB = { id: "", slug: "" };
  let support: Person; let billing: Person; let superUser: Person; let staffOnly: Person;
  let supportSession: SignedIn; let superSession: SignedIn; let staffSession: SignedIn;
  let notificationId = "";

  beforeAll(async () => {
    runtime = postgres(runtimeUrl ?? "", { max: 1, prepare: false, onnotice: () => {} });
    tenantA = await fixture.tenant("admin-a");
    tenantB = await fixture.tenant("admin-b");
    staffOnly = await fixture.person("staff", { tenantId: tenantA.id });
    support = await fixture.person("support"); billing = await fixture.person("billing"); superUser = await fixture.person("super");
    await fixture.makeOperator(support, "support"); await fixture.makeOperator(billing, "billing"); await fixture.makeOperator(superUser, "super");
    staffSession = await fixture.signInWithSecondFactor(staffOnly);
    // None of the operators belongs to a business: signing in must still work for them.
    supportSession = await fixture.signInWithSecondFactor(support);
    await fixture.signInWithSecondFactor(billing);
    superSession = await fixture.signInWithSecondFactor(superUser);

    notificationId = randomUUID();
    await fixture.owner`
      insert into notifications (id, tenant_id, channel, template_key, destination_ciphertext, semantic_key, status, scheduled_at, failed_at, failure_code, attempt_count)
      values (${notificationId}, ${tenantA.id}, 'email', 'appointment.reminder', 'ciphertext-secret-destination-9876543210', ${`reminder-${notificationId}`}, 'failed', now() - interval '1 hour', now() - interval '50 minutes', 'suppressed_bounced', 3)`;
    await fixture.owner`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key, status, attempt_count, last_error_code)
      values (${tenantA.id}, 'notification', ${notificationId}, 'appointment.reminder', '{}'::jsonb, ${`ob-${notificationId}`}, 'dead_letter', 5, 'suppressed_bounced')`;
  });

  afterAll(async () => {
    await runtime.end();
    await fixture.end();
  });

  it("answers 404 not_found to a staff member and to someone with no session at all", async () => {
    await expect(getAdminContext(staffSession.headers)).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(getAdminContext(new Headers())).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("lets operators sign in without a business, and gives staff routes no business to a bare operator", async () => {
    await expect(getAdminContext(supportSession.headers)).resolves.toMatchObject({ role: "support", userId: support.id });
    await expect(getAdminContext(superSession.headers)).resolves.toMatchObject({ role: "super" });
    await expect(getStaffContext(supportSession.headers)).rejects.toMatchObject({ status: 403 });
  });

  it("refuses an operator with no second factor, one who has not used it this sign-in, and one whose check is older than 12 hours", async () => {
    const noFactor = await fixture.person("nofactor"); await fixture.makeOperator(noFactor, "support");
    const bare = await fixture.signIn(noFactor);
    await expect(getAdminContext(bare.headers)).rejects.toMatchObject({ status: 403, code: "second_factor_required" });

    await fixture.owner`update auth_users set two_factor_enabled = true where id = ${noFactor.id}`;
    await expect(getAdminContext(bare.headers)).rejects.toMatchObject({ code: "second_factor_pending" });

    const stale = await fixture.signInWithSecondFactor(await fixture.person("stale").then(async (person) => { await fixture.makeOperator(person, "support"); return person; }), 13);
    await expect(getAdminContext(stale.headers)).rejects.toMatchObject({ code: "second_factor_pending" });
  });

  it("answers 404 to a staff-only user on every /api/admin route, whatever the method", async () => {
    const root = resolve(__dirname, "../..");
    const files = globSync("src/app/api/admin/**/route.ts", { cwd: root });
    expect(files.length).toBeGreaterThanOrEqual(12);
    for (const file of files) {
      const routeModule = await import(/* @vite-ignore */ resolve(root, file)) as Record<string, unknown>;
      for (const method of ["GET", "POST", "PUT"] as const) {
        const handler = routeModule[method];
        if (typeof handler !== "function") continue;
        const headers = new Headers(staffSession.headers);
        headers.set("content-type", "application/json"); headers.set("idempotency-key", "route-test-key-0001");
        const request = new Request("http://localhost:3000/api/admin/x?id=abcdefgh123", { method, headers, ...(method === "GET" ? {} : { body: "{}" }) });
        const response = await (handler as (request: Request, context: unknown) => Promise<Response>)(request, { params: Promise.resolve({ id: "abcdefgh123" }) });
        expect(response.status, `${method} ${file}`).toBe(404);
      }
    }
  });

  it("lets a support operator find why a reminder was not delivered, with no name or destination in the answer", async () => {
    const found = await findMessages(support.id, notificationId);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ status: "failed", failureCode: "suppressed_bounced", explanation: "Skipped: the address bounced earlier.", attemptCount: 3, tenantId: tenantA.id });
    expect(found[0]?.outbox[0]).toMatchObject({ status: "dead_letter", lastErrorCode: "suppressed_bounced" });
    const text = JSON.stringify(found);
    expect(text).not.toContain("ciphertext-secret");
    expect(text).not.toContain("9876543210");
    expect(text).not.toContain(staffOnly.name);
    expect(text).not.toContain("example.com");
  });

  it("keeps the message search from billing and answers an unknown id with nothing", async () => {
    await expect(findMessages(billing.id, notificationId)).rejects.toMatchObject({ status: 404 });
    await expect(findMessages(support.id, randomUUID())).resolves.toEqual([]);
  });

  it("lists businesses and one business's health without any customer content", async () => {
    const list = await listTenants(support.id, { status: "all", page: 1, search: "admin-" });
    expect(list.items.map((item) => item.tenantId)).toEqual(expect.arrayContaining([tenantA.id, tenantB.id]));
    expect(list.pageSize).toBe(25);
    const health = await tenantHealth(billing.id, tenantA.id);
    expect(health.messages7d["email:failed"]).toBe(1);
    expect(health.recentErrors).toEqual([{ code: "suppressed_bounced", count: 1 }]);
    expect(health.deadLetters).toBe(1);
    expect(JSON.stringify(health)).not.toContain(staffOnly.email);
    await expect(tenantHealth(staffOnly.id, tenantA.id)).rejects.toMatchObject({ status: 404 });
  });

  it("refuses the database functions to a non-operator, called directly", async () => {
    await expect(runtime`select * from admin_list_tenants(${staffOnly.id}, '', 'all', 25, 0)`).rejects.toMatchObject({ message: expect.stringContaining("platform role required") });
    await expect(runtime`select admin_worker_health(${randomUUID()})`).rejects.toMatchObject({ message: expect.stringContaining("platform role required") });
  });

  it("gives the runtime role no way to read the operator list or the audit trail, or to change an audit event", async () => {
    const [{ admins }] = await fixture.owner<{ admins: number }[]>`select count(*)::int as admins from platform_admins`;
    const [{ audits }] = await fixture.owner<{ audits: number }[]>`select count(*)::int as audits from platform_audit_events`;
    expect(admins).toBeGreaterThanOrEqual(3);
    expect(audits).toBeGreaterThan(0);
    expect(await runtime`select * from platform_admins`).toHaveLength(0);
    expect(await runtime`select * from platform_audit_events`).toHaveLength(0);
    const updated = await runtime`update platform_audit_events set reason = 'changed' returning id`.catch(() => []);
    const deleted = await runtime`delete from platform_audit_events returning id`.catch(() => []);
    expect(updated).toHaveLength(0);
    expect(deleted).toHaveLength(0);
    await expect(runtime`insert into platform_audit_events (admin_user_id, action) values ('x', 'forged')`).rejects.toThrow();
    // Even the owner cannot rewrite history: the append-only trigger refuses.
    await expect(fixture.owner`update platform_audit_events set reason = 'changed'`).rejects.toMatchObject({ message: expect.stringContaining("never edited or deleted") });
    await expect(fixture.owner`delete from platform_audit_events`).rejects.toMatchObject({ message: expect.stringContaining("never edited or deleted") });
    const [{ after }] = await fixture.owner<{ after: number }[]>`select count(*)::int as after from platform_audit_events`;
    expect(after).toBeGreaterThanOrEqual(audits);
  });

  it("lets only super manage operators, by email, with a reason, and never remove oneself", async () => {
    const newcomer = await fixture.person("newcomer");
    await expect(setOperator(support.id, { email: newcomer.email, role: "support", active: true, reason: "Not allowed" })).rejects.toMatchObject({ status: 404 });
    await expect(setOperator(superUser.id, { email: newcomer.email, role: "billing", active: true, reason: "New finance colleague" })).resolves.toBe(true);
    await expect(setOperator(superUser.id, { email: "nobody@example.com", role: "billing", active: true, reason: "Unknown person" })).resolves.toBe(false);
    const operators = await listOperators(superUser.id);
    expect(operators.find((row) => row.userId === newcomer.id)).toMatchObject({ role: "billing", isActive: true });
    expect(JSON.stringify(operators)).not.toContain("@");
    await expect(setOperator(superUser.id, { email: superUser.email, role: "super", active: false, reason: "Remove myself" })).rejects.toBeInstanceOf(ApiError);
    await expect(listOperators(support.id)).rejects.toMatchObject({ status: 404 });
  });

  it("records what operators did in the audit trail, readable by every role and only through the function", async () => {
    const trail = await listAudit(billing.id, null, 100);
    expect(trail.map((row) => row.action)).toEqual(expect.arrayContaining(["admin.message.searched", "admin.tenant.viewed", "admin.operator.set"]));
    await expect(listAudit(staffOnly.id, null, 10)).rejects.toMatchObject({ status: 404 });
  });

  it("keeps business A's support sessions out of business B's view", async () => {
    await fixture.owner`
      insert into impersonation_sessions (admin_user_id, tenant_id, reason, token_hash, ends_at) values
      (${support.id}, ${tenantA.id}, 'Looking at A for a test', ${randomUUID().replace(/-/g, "").padEnd(64, "a")}, now() + interval '10 minutes'),
      (${support.id}, ${tenantB.id}, 'Looking at B for a test', ${randomUUID().replace(/-/g, "").padEnd(64, "b")}, now() + interval '10 minutes')`;
    const seenByA = await withTenant(tenantA.id, (transaction) => transaction.execute<{ tenant_id: string }>(sql`select tenant_id from impersonation_sessions`));
    const seenByB = await withTenant(tenantB.id, (transaction) => transaction.execute<{ tenant_id: string }>(sql`select tenant_id from impersonation_sessions`));
    expect([...new Set(seenByA.map((row) => row.tenant_id))]).toEqual([tenantA.id]);
    expect([...new Set(seenByB.map((row) => row.tenant_id))]).toEqual([tenantB.id]);
  });
});
