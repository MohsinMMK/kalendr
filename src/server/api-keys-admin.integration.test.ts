/** @vitest-environment node */

import { createHash } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resolvePermissions } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";
import { isolatedDatabaseReady } from "@/test/isolated-database";

vi.mock("server-only", () => ({}));

import { getApiKeyContext } from "@/server/api-key-context";
import { createApiKey, listApiKeys, revokeApiKey } from "@/server/api-keys-admin";
import { maxActiveApiKeys } from "@/server/api-keys-contracts";

const describeLocal = isolatedDatabaseReady(process.env.DATABASE_URL, process.env.KALENDR_TEST_OWNER_URL) ? describe : describe.skip;

const secretName = "Zebra stripe integration";

describeLocal("API key administration", () => {
  let owner: postgres.Sql;
  let tenantA = "";
  let tenantB = "";

  const context = (tenantId: string, role: "owner" | "admin", stepUp: "fresh" | "stale" | "none" = "fresh"): StaffContext => ({
    tenantId, clinicSlug: "x", clinicName: "X", role, permissions: resolvePermissions(role, {}),
    membershipId: null, userId: null, userName: "Desk", userEmail: "test@example.com", preview: false,
    secondFactorEnrolled: stepUp !== "none",
    secondFactorAt: stepUp === "fresh" ? new Date() : stepUp === "stale" ? new Date(Date.now() - 30 * 60_000) : null,
  });
  const body = (extra: Record<string, unknown> = {}) => ({ name: secretName, mode: "live", scopes: ["services:read"], ...extra });
  const headersFor = (key: string) => new Headers({ authorization: `Bearer ${key}`, "x-forwarded-for": "192.0.2.77" });

  beforeAll(async () => {
    owner = postgres(process.env.KALENDR_TEST_OWNER_URL!, { max: 2, prepare: false });
    const [a] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    const [b] = await owner<{ id: string }[]>`select id from tenants where slug = 'riverbend-care'`;
    tenantA = a!.id;
    tenantB = b!.id;
    await owner`delete from api_keys where tenant_id in (${tenantA}, ${tenantB})`;
  });

  afterAll(async () => {
    await owner`delete from audit_events where tenant_id in (${tenantA}, ${tenantB}) and action like 'api_key.%'`;
    await owner`delete from api_keys where tenant_id in (${tenantA}, ${tenantB})`;
    await owner.end();
  });

  it("lets only the owner create a key, and asks an admin to go to the owner in plain words", async () => {
    await expect(createApiKey(context(tenantA, "admin"), body())).rejects.toMatchObject({ status: 403, code: "owner_only" });
  });

  it("needs a fresh second-factor check", async () => {
    await expect(createApiKey(context(tenantA, "owner", "stale"), body())).rejects.toMatchObject({ status: 403, code: "step_up_required" });
    await expect(createApiKey(context(tenantA, "owner", "none"), body())).rejects.toMatchObject({ status: 403, code: "second_factor_required" });
  });

  it("stores only the hash, shows the key once, and never lists the hash", async () => {
    const created = await createApiKey(context(tenantA, "owner"), body());
    expect(created.secret).toMatch(/^kal_live_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(created.key)).not.toContain(created.secret);
    const [row] = await owner<{ key_hash: string; prefix: string }[]>`select key_hash, prefix from api_keys where id = ${created.key.id}`;
    expect(row!.key_hash).toBe(createHash("sha256").update(created.secret).digest("hex"));
    expect(row!.key_hash).not.toBe(created.secret);
    expect(created.secret.startsWith(row!.prefix)).toBe(true);
    expect(created.key.prefix).toBe(row!.prefix);
    const listed = await listApiKeys(context(tenantA, "owner"));
    expect(listed.keys.map((key) => key.id)).toContain(created.key.id);
    expect(JSON.stringify(listed)).not.toContain(row!.key_hash);
    expect(JSON.stringify(listed)).not.toContain(created.secret);
  });

  it("refuses a revoked key straight away and records who revoked it without the key or its name", async () => {
    const created = await createApiKey(context(tenantA, "owner"), body());
    expect((await getApiKeyContext(headersFor(created.secret), "services:read")).keyId).toBe(created.key.id);
    const revoked = await revokeApiKey(context(tenantA, "admin"), created.key.id);
    expect(revoked.key.revokedAt).not.toBeNull();
    await expect(getApiKeyContext(headersFor(created.secret), "services:read")).rejects.toMatchObject({ status: 401 });
    // A second revoke is fine and does not write a second audit row.
    await revokeApiKey(context(tenantA, "owner"), created.key.id);
    const audit = await owner<{ action: string; metadata: unknown }[]>`select action, metadata from audit_events where tenant_id = ${tenantA} and metadata->>'keyId' = ${created.key.id} order by occurred_at`;
    expect(audit.map((entry) => entry.action)).toEqual(["api_key.created", "api_key.revoked"]);
    const text = JSON.stringify(audit);
    expect(text).not.toContain(created.secret);
    expect(text).not.toContain(secretName);
    expect(text).toContain(created.key.prefix);
  });

  it("refuses a test key with a write scope and a bad expiry with field errors", async () => {
    await expect(createApiKey(context(tenantA, "owner"), body({ mode: "test", scopes: ["appointments:write"] }))).rejects.toMatchObject({ status: 400, fieldErrors: { scopes: expect.any(Array) } });
    await expect(createApiKey(context(tenantA, "owner"), body({ expiresAt: new Date(Date.now() - 1000).toISOString() }))).rejects.toMatchObject({ status: 400 });
  });

  it("keeps one business's keys from another business, for listing and revoking", async () => {
    const created = await createApiKey(context(tenantA, "owner"), body());
    const other = await listApiKeys(context(tenantB, "owner"));
    expect(other.keys.map((key) => key.id)).not.toContain(created.key.id);
    await expect(revokeApiKey(context(tenantB, "owner"), created.key.id)).rejects.toMatchObject({ status: 404 });
    const [row] = await owner<{ revoked_at: Date | null }[]>`select revoked_at from api_keys where id = ${created.key.id}`;
    expect(row!.revoked_at).toBeNull();
  });

  it("stops at the active key limit and frees a place when one is revoked", async () => {
    await owner`delete from api_keys where tenant_id = ${tenantB}`;
    const made: string[] = [];
    for (let index = 0; index < maxActiveApiKeys; index += 1) made.push((await createApiKey(context(tenantB, "owner"), body())).key.id);
    await expect(createApiKey(context(tenantB, "owner"), body())).rejects.toMatchObject({ status: 409, code: "too_many_keys" });
    await revokeApiKey(context(tenantB, "owner"), made[0]!);
    await expect(createApiKey(context(tenantB, "owner"), body())).resolves.toBeTruthy();
  });
});
