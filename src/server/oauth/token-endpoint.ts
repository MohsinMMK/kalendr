import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { getDatabase, withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents, oauthClients, oauthCodes, oauthGrants, oauthTokens } from "@/db/schema";
import { isApiScope } from "@/lib/api-scopes";
import {
  ACCESS_TOKEN_SECONDS, builtinClientById, REFRESH_TOKEN_SECONDS, type TokenRequest, type TokenResponse,
} from "@/lib/oauth";
import { rateLimitRules } from "@/server/rate-limit-rules";
import { clientAddress, hitRateLimit, recordRefusal } from "@/server/rate-limit";

import { OAuthError } from "./errors";
import { hashToken, newToken, pkceChallenge, sameText } from "./tokens";

/**
 * The token endpoint (feature 55). It swaps a one-use code for an access and a refresh token, and a refresh token for
 * a new pair. Every failure is `invalid_grant` or `invalid_client` with the same plain sentence whatever was wrong, so
 * a caller learns nothing about which part of a guess was close.
 */

const BAD_GRANT = "The code or token is not valid any more. Start the connection again.";

async function ipLimit(headers: Headers): Promise<void> {
  const result = await hitRateLimit("oauth.token.ip", clientAddress(headers));
  if (!result.allowed) {
    recordRefusal("oauth.token.ip");
    throw new OAuthError("rate_limited", rateLimitRules["oauth.token.ip"].message, 429, { "Retry-After": String(result.retryAfterSeconds) });
  }
}

interface TenantRow extends Record<string, unknown> { tenant_id: string }

async function tenantOf(fn: "kalendr_resolve_oauth_code" | "kalendr_resolve_oauth_refresh", hash: string): Promise<string | null> {
  const database = getDatabase();
  if (!database) throw new OAuthError("invalid_request", "Business data is unavailable.", 503);
  const rows = fn === "kalendr_resolve_oauth_code"
    ? await database.execute<TenantRow>(sql`select tenant_id from kalendr_resolve_oauth_code(${hash})`)
    : await database.execute<TenantRow>(sql`select tenant_id from kalendr_resolve_oauth_refresh(${hash})`);
  return rows[0]?.tenant_id ?? null;
}

type Grant = typeof oauthGrants.$inferSelect;

/** Public clients (ours) name themselves; registered apps must also present a secret that matches. */
async function checkClient(transaction: KalendrTransaction, tenantId: string, grant: Grant, request: { client_id: string; client_secret?: string | undefined }, headers: Headers): Promise<void> {
  if (grant.clientId !== request.client_id) throw new OAuthError("invalid_grant", BAD_GRANT);
  if (grant.clientKind === "builtin") {
    if (!builtinClientById(grant.clientId)) throw new OAuthError("invalid_grant", BAD_GRANT);
    return;
  }
  const limited = await hitRateLimit("oauth.client.ip", clientAddress(headers));
  if (!limited.allowed) {
    recordRefusal("oauth.client.ip");
    throw new OAuthError("rate_limited", rateLimitRules["oauth.client.ip"].message, 429, { "Retry-After": String(limited.retryAfterSeconds) });
  }
  const [client] = await transaction.select().from(oauthClients)
    .where(and(eq(oauthClients.tenantId, tenantId), eq(oauthClients.id, grant.clientId), isNull(oauthClients.revokedAt))).limit(1);
  if (!client || !request.client_secret || !sameText(client.secretHash, hashToken(request.client_secret))) {
    throw new OAuthError("invalid_client", "The app's client id or secret is wrong.", 401);
  }
}

export async function issuePair(transaction: KalendrTransaction, tenantId: string, grant: Grant, now: Date): Promise<TokenResponse> {
  const access = newToken("access");
  const refresh = newToken("refresh");
  await transaction.insert(oauthTokens).values([
    { tenantId, grantId: grant.id, kind: "access", tokenHash: hashToken(access), expiresAt: new Date(now.getTime() + ACCESS_TOKEN_SECONDS * 1_000) },
    { tenantId, grantId: grant.id, kind: "refresh", tokenHash: hashToken(refresh), expiresAt: new Date(now.getTime() + REFRESH_TOKEN_SECONDS * 1_000) },
  ]);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refresh, scope: grant.scopes.filter(isApiScope).join(" ") };
}

async function revokeEverything(transaction: KalendrTransaction, tenantId: string, grantId: string, reason: "code_replay" | "refresh_replay", now: Date): Promise<void> {
  await transaction.update(oauthGrants).set({ revokedAt: now }).where(and(eq(oauthGrants.tenantId, tenantId), eq(oauthGrants.id, grantId), isNull(oauthGrants.revokedAt)));
  await transaction.update(oauthTokens).set({ revokedAt: now }).where(and(eq(oauthTokens.tenantId, tenantId), eq(oauthTokens.grantId, grantId), isNull(oauthTokens.revokedAt)));
  await transaction.insert(auditEvents).values({
    tenantId, actorType: "system", action: "oauth_grant.revoked", outcome: "success", metadata: { grantId, reason },
  });
}

/**
 * A failed replay must still revoke the grant, so the refusal is returned out of the transaction as a value and thrown
 * after it commits; a throw inside would roll the revocation back.
 */
type Outcome = { ok: TokenResponse } | { refused: OAuthError };

export async function exchangeToken(request: TokenRequest, headers: Headers, now: Date = new Date()): Promise<TokenResponse> {
  await ipLimit(headers);
  const outcome = request.grant_type === "authorization_code" ? await exchangeCode(request, headers, now) : await exchangeRefresh(request, headers, now);
  if ("refused" in outcome) throw outcome.refused;
  return outcome.ok;
}

async function exchangeCode(request: Extract<TokenRequest, { grant_type: "authorization_code" }>, headers: Headers, now: Date): Promise<Outcome> {
  const tenantId = await tenantOf("kalendr_resolve_oauth_code", hashToken(request.code));
  if (!tenantId) return { refused: new OAuthError("invalid_grant", BAD_GRANT) };
  return withTenant(tenantId, async (transaction): Promise<Outcome> => {
    const [code] = await transaction.select().from(oauthCodes)
      .where(and(eq(oauthCodes.tenantId, tenantId), eq(oauthCodes.codeHash, hashToken(request.code)))).for("update").limit(1);
    if (!code) return { refused: new OAuthError("invalid_grant", BAD_GRANT) };
    if (code.usedAt) {
      // A code used twice was copied: shut down what the first use opened.
      await revokeEverything(transaction, tenantId, code.grantId, "code_replay", now);
      return { refused: new OAuthError("invalid_grant", BAD_GRANT) };
    }
    const [grant] = await transaction.select().from(oauthGrants).where(and(eq(oauthGrants.tenantId, tenantId), eq(oauthGrants.id, code.grantId))).limit(1);
    if (!grant || grant.revokedAt || code.expiresAt <= now || code.redirectUri !== request.redirect_uri
      || !sameText(code.codeChallenge, pkceChallenge(request.code_verifier))) {
      return { refused: new OAuthError("invalid_grant", BAD_GRANT) };
    }
    try {
      await checkClient(transaction, tenantId, grant, request, headers);
    } catch (error: unknown) {
      if (error instanceof OAuthError) return { refused: error };
      throw error;
    }
    await transaction.update(oauthCodes).set({ usedAt: now }).where(and(eq(oauthCodes.tenantId, tenantId), eq(oauthCodes.id, code.id)));
    return { ok: await issuePair(transaction, tenantId, grant, now) };
  });
}

async function exchangeRefresh(request: Extract<TokenRequest, { grant_type: "refresh_token" }>, headers: Headers, now: Date): Promise<Outcome> {
  const hash = hashToken(request.refresh_token);
  const tenantId = await tenantOf("kalendr_resolve_oauth_refresh", hash);
  if (!tenantId) return { refused: new OAuthError("invalid_grant", BAD_GRANT) };
  return withTenant(tenantId, async (transaction): Promise<Outcome> => {
    const [token] = await transaction.select().from(oauthTokens)
      .where(and(eq(oauthTokens.tenantId, tenantId), eq(oauthTokens.tokenHash, hash), eq(oauthTokens.kind, "refresh"))).for("update").limit(1);
    if (!token) return { refused: new OAuthError("invalid_grant", BAD_GRANT) };
    if (token.usedAt) {
      await revokeEverything(transaction, tenantId, token.grantId, "refresh_replay", now);
      return { refused: new OAuthError("invalid_grant", BAD_GRANT) };
    }
    const [grant] = await transaction.select().from(oauthGrants).where(and(eq(oauthGrants.tenantId, tenantId), eq(oauthGrants.id, token.grantId))).limit(1);
    if (!grant || grant.revokedAt || token.revokedAt || token.expiresAt <= now) return { refused: new OAuthError("invalid_grant", BAD_GRANT) };
    try {
      await checkClient(transaction, tenantId, grant, request, headers);
    } catch (error: unknown) {
      if (error instanceof OAuthError) return { refused: error };
      throw error;
    }
    await transaction.update(oauthTokens).set({ usedAt: now, revokedAt: now }).where(and(eq(oauthTokens.tenantId, tenantId), eq(oauthTokens.id, token.id)));
    return { ok: await issuePair(transaction, tenantId, grant, now) };
  });
}

/** Tells an app its own token is finished (RFC 7009). Always succeeds, so it reveals nothing about the value. */
export async function revokeTokenValue(value: string): Promise<void> {
  const hash = hashToken(value);
  const database = getDatabase();
  if (!database) return;
  const [row] = await database.execute<{ tenant_id: string; grant_id: string }>(sql`
    select tenant_id, grant_id from kalendr_resolve_oauth_refresh(${hash})
    union all select tenant_id, grant_id from kalendr_resolve_oauth_token(${hash}) limit 1`).catch(() => []);
  if (!row) return;
  const now = new Date();
  await withTenant(row.tenant_id, async (transaction) => {
    await transaction.update(oauthGrants).set({ revokedAt: now }).where(and(eq(oauthGrants.tenantId, row.tenant_id), eq(oauthGrants.id, row.grant_id), isNull(oauthGrants.revokedAt)));
    await transaction.update(oauthTokens).set({ revokedAt: now }).where(and(eq(oauthTokens.tenantId, row.tenant_id), eq(oauthTokens.grantId, row.grant_id), isNull(oauthTokens.revokedAt)));
  });
}
