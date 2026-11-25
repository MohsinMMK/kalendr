import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { getDatabase, withTenant } from "@/db/client";
import { scimTokens } from "@/db/schema";
import { canUse } from "@/lib/entitlements";
import { loadEntitlements } from "@/server/entitlements";
import { bearerToken } from "@/server/api-key-context";
import { hashScimToken, looksLikeScimToken } from "@/server/enterprise/scim-tokens";
import { clientAddress, hitRateLimit, recordRefusal } from "@/server/rate-limit";
import { rateLimitRules } from "@/server/rate-limit-rules";

import { ScimError } from "./protocol";

export interface ScimContext {
  tenantId: string;
  tokenId: string;
  defaultRole: "receptionist" | "practitioner" | "billing" | "read_only";
}

function refuse(status: number, detail: string, retryAfter?: number): never {
  throw new ScimError(status, detail, undefined, retryAfter);
}

/**
 * Turns the bearer token into a business: the token's hash is looked up through a narrow database function that returns ids only.
 * Wrong tokens are counted per network, so guessing is slow. A business whose plan no longer has the enterprise features is refused
 * with the same 403 whatever the token, and nothing about the token is ever logged.
 */
export async function getScimContext(headers: Headers): Promise<ScimContext> {
  const token = bearerToken(headers);
  const database = getDatabase();
  if (!database) throw new ScimError(503, "The directory service is unavailable.");
  const bad = async (): Promise<never> => {
    const result = await hitRateLimit("scim.bad_token", clientAddress(headers));
    if (!result.allowed) {
      recordRefusal("scim.bad_token");
      refuse(429, rateLimitRules["scim.bad_token"].message, result.retryAfterSeconds);
    }
    return refuse(401, "Send a valid directory token as `Authorization: Bearer <token>`.");
  };
  if (!token || !looksLikeScimToken(token)) return bad();
  const rows = await database.execute<{ tenant_id: string; token_id: string; default_role: ScimContext["defaultRole"] }>(sql`select * from kalendr_resolve_scim_token(${hashScimToken(token)})`);
  const row = rows[0];
  if (!row) return bad();
  const rate = await hitRateLimit("scim.token", row.token_id);
  if (!rate.allowed) {
    recordRefusal("scim.token");
    refuse(429, rateLimitRules["scim.token"].message, rate.retryAfterSeconds);
  }
  const allowed = await withTenant(row.tenant_id, async (transaction) => {
    const { entitlements } = await loadEntitlements(row.tenant_id, transaction);
    if (!canUse(entitlements, "enterprise")) return false;
    // Last-used is for the owner's eyes; once a minute is plenty.
    await transaction.update(scimTokens).set({ lastUsedAt: new Date() })
      .where(and(eq(scimTokens.tenantId, row.tenant_id), eq(scimTokens.id, row.token_id), isNull(scimTokens.revokedAt), sql`(${scimTokens.lastUsedAt} is null or ${scimTokens.lastUsedAt} < now() - interval '1 minute')`));
    return true;
  });
  if (!allowed) refuse(403, "Directory sync is not part of this business's plan.");
  return { tenantId: row.tenant_id, tokenId: row.token_id, defaultRole: row.default_role };
}
