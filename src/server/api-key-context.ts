import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";

import { getDatabase, withTenant } from "@/db/client";
import { apiKeys, memberships, oauthGrants } from "@/db/schema";
import { apiWriteScopes, type ApiKeyMode, type ApiScope } from "@/lib/api-scopes";
import { rateLimitRules } from "@/server/rate-limit-rules";
import { ApiError } from "@/server/api-error";
import { clientAddress, hitRateLimit, recordRefusal, type RateLimitResult } from "@/server/rate-limit";
import { accessTokenPattern, hashToken } from "@/server/oauth/tokens";
import { scopesWithin } from "@/server/oauth/authorize";
import { loadCustomPermissions } from "@/server/enterprise/role-permissions";
import { isStaffRole, resolvePermissions, type Permission } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";

/**
 * API keys (feature 34). A key looks like `kal_live_<43 characters>`: 256 random bits. Only its SHA-256
 * hash is stored, with the first characters as a visible prefix so a leaked key can be traced.
 */

const PREFIX_VISIBLE = 6;
const KEY_PATTERN = /^kal_(live|test)_[A-Za-z0-9_-]{43}$/;

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export interface GeneratedApiKey {
  key: string;
  prefix: string;
  keyHash: string;
}

export function generateApiKey(mode: ApiKeyMode): GeneratedApiKey {
  const secret = randomBytes(32).toString("base64url");
  const key = `kal_${mode}_${secret}`;
  return { key, prefix: `kal_${mode}_${secret.slice(0, PREFIX_VISIBLE)}`, keyHash: hashApiKey(key) };
}

export interface ApiKeyContext {
  tenantId: string;
  clinicSlug: string;
  clinicName: string;
  keyId: string;
  keyPrefix: string;
  scopes: readonly ApiScope[];
  mode: ApiKeyMode;
  /** Whole-window counts for the response headers. */
  rate: RateLimitResult;
  /** Set when an OAuth access token made the request (feature 55): the person who approved the app, and the approval. */
  userId?: string | null;
  grantId?: string;
}

interface ResolvedKeyRow extends Record<string, unknown> {
  tenant_id: string;
  key_id: string;
  prefix: string;
  scopes: string[];
  mode: string;
  clinic_slug: string;
  clinic_name: string;
  last_used_at: Date | null;
}

export function bearerToken(headers: Headers): string | null {
  const header = headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function unauthorized(): ApiError {
  return new ApiError(401, "invalid_api_key", "Send a valid API key as `Authorization: Bearer <key>`.", undefined, { "WWW-Authenticate": 'Bearer realm="kalendr"' });
}

/**
 * Turns the request's key into a business and a scope list, counts it against the key's rate limit and
 * checks the one scope the route needs. Everything after this runs through `withTenant`, like a staff request.
 */
export async function getApiKeyContext(headers: Headers, requiredScope: ApiScope): Promise<ApiKeyContext> {
  const token = bearerToken(headers);
  if (token?.startsWith("kat_")) return getAccessTokenContext(headers, token, requiredScope);
  // Wrong keys are counted per network, so guessing is slow; a well-formed key that is simply unknown costs one lookup.
  if (!token || !KEY_PATTERN.test(token)) {
    await countBadKey(headers);
    throw unauthorized();
  }
  const database = getDatabase();
  if (!database) throw new ApiError(503, "database_unavailable", "Business data is unavailable.");
  const rows = await database.execute<ResolvedKeyRow>(sql`select * from kalendr_resolve_api_key(${hashApiKey(token)})`);
  const row = rows[0];
  if (!row) {
    await countBadKey(headers);
    throw unauthorized();
  }
  const rate = await hitRateLimit("api_key.minute", row.key_id);
  const rateHeaders = rateLimitHeaders(rate);
  if (!rate.allowed) {
    recordRefusal("api_key.minute");
    throw new ApiError(429, "rate_limited", rateLimitRules["api_key.minute"].message, undefined, { ...rateHeaders, "Retry-After": String(rate.retryAfterSeconds) });
  }
  const mode: ApiKeyMode = row.mode === "test" ? "test" : "live";
  const scopes = row.scopes as ApiScope[];
  if (!scopes.includes(requiredScope)) {
    throw new ApiError(403, "insufficient_scope", `This API key does not have the ${requiredScope} scope.`, undefined, rateHeaders);
  }
  if (mode === "test" && apiWriteScopes.includes(requiredScope)) {
    throw new ApiError(403, "test_key_read_only", "Test keys can only read. Use a live key to make changes.", undefined, rateHeaders);
  }
  // Last-used is for the owner's eyes, so once a minute is plenty and a busy key doesn't write on every request.
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60_000) {
    void withTenant(row.tenant_id, (transaction) => transaction.update(apiKeys).set({ lastUsedAt: new Date() })
      .where(and(eq(apiKeys.tenantId, row.tenant_id), eq(apiKeys.id, row.key_id), isNull(apiKeys.revokedAt)))).catch(() => undefined);
  }
  return { tenantId: row.tenant_id, clinicSlug: row.clinic_slug, clinicName: row.clinic_name, keyId: row.key_id, keyPrefix: row.prefix, scopes, mode, rate };
}

interface ResolvedTokenRow extends Record<string, unknown> {
  tenant_id: string;
  token_id: string;
  grant_id: string;
  scopes: string[];
  user_id: string;
  client_name: string;
  clinic_slug: string;
  clinic_name: string;
  last_used_at: Date | null;
}

/**
 * An OAuth access token (feature 55) works like a live API key limited to the approval's scopes. The lookup joins the
 * approval, the person and the business, so revoking the approval, removing the person or pausing the business stops
 * the very next request. The scopes are also cut down to what the person may do today, so a change of role takes effect
 * at once instead of when the approval is revoked.
 */
async function getAccessTokenContext(headers: Headers, token: string, requiredScope: ApiScope): Promise<ApiKeyContext> {
  if (!accessTokenPattern.test(token)) {
    await countBadKey(headers);
    throw unauthorized();
  }
  const database = getDatabase();
  if (!database) throw new ApiError(503, "database_unavailable", "Business data is unavailable.");
  const rows = await database.execute<ResolvedTokenRow>(sql`select * from kalendr_resolve_oauth_token(${hashToken(token)})`);
  const row = rows[0];
  if (!row) {
    await countBadKey(headers);
    throw unauthorized();
  }
  const rate = await hitRateLimit("api_key.minute", row.grant_id);
  const rateHeaders = rateLimitHeaders(rate);
  if (!rate.allowed) {
    recordRefusal("api_key.minute");
    throw new ApiError(429, "rate_limited", rateLimitRules["api_key.minute"].message, undefined, { ...rateHeaders, "Retry-After": String(rate.retryAfterSeconds) });
  }
  const scopes = scopesWithin(await currentPermissions(row.tenant_id, row.user_id), row.scopes as ApiScope[]);
  if (!scopes.includes(requiredScope)) {
    throw new ApiError(403, "insufficient_scope", `This connection does not have the ${requiredScope} scope.`, undefined, rateHeaders);
  }
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60_000) {
    void withTenant(row.tenant_id, (transaction) => transaction.update(oauthGrants).set({ lastUsedAt: new Date() })
      .where(and(eq(oauthGrants.tenantId, row.tenant_id), eq(oauthGrants.id, row.grant_id), isNull(oauthGrants.revokedAt)))).catch(() => undefined);
  }
  return {
    tenantId: row.tenant_id, clinicSlug: row.clinic_slug, clinicName: row.clinic_name, keyId: row.grant_id, keyPrefix: "oauth",
    scopes, mode: "live", rate, userId: row.user_id, grantId: row.grant_id,
  };
}

/** What the person who approved the app may do now: their role, its overrides and any custom role. */
async function currentPermissions(tenantId: string, userId: string): Promise<Permission[]> {
  return withTenant(tenantId, async (transaction) => {
    const [member] = await transaction
      .select({ id: memberships.id, role: memberships.role, overrides: memberships.permissionOverrides })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId), eq(memberships.isActive, true)))
      .limit(1);
    if (!member || !isStaffRole(member.role)) return [];
    return resolvePermissions(member.role, member.overrides, await loadCustomPermissions(transaction, tenantId, member.id));
  });
}

async function countBadKey(headers: Headers): Promise<void> {
  const result = await hitRateLimit("api_key.bad_key", clientAddress(headers));
  if (!result.allowed) {
    recordRefusal("api_key.bad_key");
    throw new ApiError(429, "rate_limited", rateLimitRules["api_key.bad_key"].message, undefined, { "Retry-After": String(result.retryAfterSeconds) });
  }
}

export function rateLimitHeaders(rate: RateLimitResult): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(rate.limit),
    "X-RateLimit-Remaining": String(Math.max(0, rate.limit - rate.count)),
    "X-RateLimit-Reset": String(Math.ceil(rate.resetAt.getTime() / 1_000)),
  };
}

/**
 * The staff-shaped identity the shared booking code expects. It has no user: the audit trail records the key's id and
 * prefix instead. The permissions are only what the key's scopes allow, so the same checks the app uses still apply.
 */
export function staffContextFor(context: ApiKeyContext): StaffContext {
  const permissions: Permission[] = [];
  if (context.scopes.includes("appointments:write")) permissions.push("appointments.book", "appointments.status");
  if (context.scopes.includes("customers:write")) permissions.push("appointments.book");
  return {
    tenantId: context.tenantId,
    clinicSlug: context.clinicSlug,
    clinicName: context.clinicName,
    role: "admin",
    permissions: [...new Set(permissions)],
    membershipId: null,
    userId: context.userId ?? null,
    userName: context.grantId ? "Connected app" : "API key",
    userEmail: "",
    secondFactorEnrolled: false,
    secondFactorAt: null,
    preview: false,
    apiKeyId: context.keyId,
    apiKeyPrefix: context.keyPrefix,
  };
}

/** Constant-time check that two key hashes match. Used where a stored hash is compared with a presented one. */
export function sameKeyHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
