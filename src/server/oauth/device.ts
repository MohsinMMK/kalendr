import "server-only";

import { randomInt } from "node:crypto";

import { sql } from "drizzle-orm";

import { getDatabase, withTenant } from "@/db/client";
import { auditEvents, oauthGrants } from "@/db/schema";
import { isApiScope, type ApiScope } from "@/lib/api-scopes";
import {
  builtinClientById, DEVICE_CODE_SECONDS, DEVICE_POLL_SECONDS, describeScopes, formatUserCode, normalizeUserCode,
  parseScopeList, USER_CODE_ALPHABET, type ConsentView, type TokenResponse,
} from "@/lib/oauth";
import { ApiError } from "@/server/api-error";
import { clientAddress, hitRateLimit, recordRefusal } from "@/server/rate-limit";
import { rateLimitRules, type RateLimitRuleName } from "@/server/rate-limit-rules";
import { appOrigin } from "@/server/env";
import { type StaffContext } from "@/server/staff-context";

import { limitToPermissions } from "./authorize";
import { OAuthError } from "./errors";
import { issuePair } from "./token-endpoint";
import { hashToken, newToken } from "./tokens";

/**
 * Device sign-in for the browser extension (feature 57, RFC 8628). The extension asks for a code and shows it; the person
 * types it on their own signed-in Kalendr page and says yes; the extension collects its tokens. No password and no redirect
 * ever pass through the extension, and the extension needs no browser permission beyond its storage and Kalendr's address.
 */

async function limit(rule: RateLimitRuleName, key: string): Promise<void> {
  const result = await hitRateLimit(rule, key);
  if (!result.allowed) {
    recordRefusal(rule);
    throw new OAuthError("rate_limited", rateLimitRules[rule].message, 429, { "Retry-After": String(result.retryAfterSeconds) });
  }
}

function db() {
  const database = getDatabase();
  if (!database) throw new OAuthError("invalid_request", "Business data is unavailable.", 503);
  return database;
}

function newUserCode(): string {
  let letters = "";
  for (let i = 0; i < 8; i += 1) letters += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return letters;
}

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export async function startDeviceFlow(input: { client_id: string; scope?: string | undefined }, headers: Headers): Promise<DeviceStart> {
  await limit("oauth.device.ip", clientAddress(headers));
  const client = builtinClientById(input.client_id);
  if (!client) throw new OAuthError("invalid_client", "This app can't use device sign-in.", 401);
  const requested = parseScopeList(input.scope);
  if (requested === null || requested.some((scope) => !client.scopes.includes(scope))) throw new OAuthError("invalid_scope", "That app asked for something it is not allowed to.");
  const scopes = requested.length > 0 ? requested : [...client.scopes];
  const deviceCode = newToken("device");
  const letters = newUserCode();
  await db().execute(sql`select kalendr_device_create(${hashToken(deviceCode)}, ${hashToken(letters)}, ${client.id}, ${`{${scopes.join(",")}}`}::text[], ${new Date(Date.now() + DEVICE_CODE_SECONDS * 1_000).toISOString()}::timestamptz)`);
  const verification = `${appOrigin().replace(/\/$/, "")}/oauth/device`;
  return {
    device_code: deviceCode, user_code: formatUserCode(letters), verification_uri: verification,
    verification_uri_complete: `${verification}?code=${formatUserCode(letters)}`, expires_in: DEVICE_CODE_SECONDS, interval: DEVICE_POLL_SECONDS,
  };
}

interface PollRow extends Record<string, unknown> { status: string; previous_poll: Date | null; expires_at: Date }
interface ClaimRow extends Record<string, unknown> { tenant_id: string; grant_id: string }

/** The extension's check: not yet, slow down, no, too late, or the tokens. Each answer is the RFC's own word. */
export async function pollDeviceFlow(input: { device_code: string; client_id: string }, headers: Headers): Promise<TokenResponse> {
  await limit("oauth.device.ip", clientAddress(headers));
  const hash = hashToken(input.device_code);
  const [row] = await db().execute<PollRow>(sql`select * from kalendr_device_poll(${hash})`);
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) throw new OAuthError("expired_token", "This code ran out. Start again.");
  if (row.previous_poll && Date.now() - new Date(row.previous_poll).getTime() < (DEVICE_POLL_SECONDS - 1) * 1_000) {
    throw new OAuthError("slow_down", "Ask less often.");
  }
  if (row.status === "pending") throw new OAuthError("authorization_pending", "Waiting for you to approve.");
  if (row.status === "denied") throw new OAuthError("access_denied", "You said no.");
  if (row.status !== "approved") throw new OAuthError("invalid_grant", "This code was already used. Start again.");
  const [claimed] = await db().execute<ClaimRow>(sql`select * from kalendr_device_claim(${hash})`);
  if (!claimed) throw new OAuthError("invalid_grant", "This code was already used. Start again.");
  return withTenant(claimed.tenant_id, async (transaction) => {
    const [grant] = await transaction.select().from(oauthGrants).where(sql`${oauthGrants.tenantId} = ${claimed.tenant_id} and ${oauthGrants.id} = ${claimed.grant_id} and ${oauthGrants.revokedAt} is null`).limit(1);
    if (!grant || grant.clientId !== input.client_id) throw new OAuthError("invalid_grant", "This connection was removed. Start again.");
    return issuePair(transaction, claimed.tenant_id, grant, new Date());
  });
}

interface LookupRow extends Record<string, unknown> { id: string; client_id: string; scopes: string[] }

async function lookup(context: StaffContext, userCode: string): Promise<{ id: string; clientId: string; clientName: string; description: string; scopes: ApiScope[] }> {
  if (context.preview || !context.userId) throw new ApiError(409, "preview_only", "Apps can't be connected in the preview.");
  const rule: RateLimitRuleName = "oauth.device_code.user";
  const counted = await hitRateLimit(rule, context.userId);
  if (!counted.allowed) {
    recordRefusal(rule);
    throw new ApiError(429, "rate_limited", rateLimitRules[rule].message, undefined, { "Retry-After": String(counted.retryAfterSeconds) });
  }
  const letters = normalizeUserCode(userCode);
  const notFound = new ApiError(404, "code_not_found", "That code was not found or has run out. Check it against the one in the extension, or start again there.");
  if (!letters) throw notFound;
  const [row] = await db().execute<LookupRow>(sql`select * from kalendr_device_lookup(${hashToken(letters)})`);
  const client = row ? builtinClientById(row.client_id) : null;
  if (!row || !client) throw notFound;
  return { id: row.id, clientId: client.id, clientName: client.name, description: client.description, scopes: limitToPermissions(context, row.scopes.filter(isApiScope)) };
}

export async function previewDevice(context: StaffContext, userCode: string): Promise<{ consent: ConsentView }> {
  const found = await lookup(context, userCode);
  return { consent: { clientName: found.clientName, clientDescription: found.description, scopes: describeScopes(found.scopes), redirectHost: new URL(appOrigin()).host } };
}

export async function decideDevice(context: StaffContext, userCode: string, approve: boolean): Promise<{ approved: boolean }> {
  const found = await lookup(context, userCode);
  if (!approve) {
    await db().execute(sql`select kalendr_device_deny(${found.id})`);
    return { approved: false };
  }
  const userId = context.userId;
  if (!userId) throw new ApiError(409, "preview_only", "Apps can't be connected in the preview.");
  const grantId = await withTenant(context.tenantId, async (transaction) => {
    const now = new Date();
    await transaction.update(oauthGrants).set({ revokedAt: now }).where(sql`${oauthGrants.tenantId} = ${context.tenantId} and ${oauthGrants.userId} = ${userId} and ${oauthGrants.clientKind} = 'builtin' and ${oauthGrants.clientId} = ${found.clientId} and ${oauthGrants.revokedAt} is null`);
    const [grant] = await transaction.insert(oauthGrants).values({
      tenantId: context.tenantId, clientKind: "builtin", clientId: found.clientId, clientName: found.clientName, userId, scopes: found.scopes,
    }).returning({ id: oauthGrants.id });
    if (!grant) throw new ApiError(500, "grant_not_created", "The connection could not be made. Try again.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: userId, actorType: "staff", action: "oauth_grant.created", outcome: "success",
      metadata: { grantId: grant.id, clientKind: "builtin", clientId: found.clientId, scopes: found.scopes, flow: "device" },
    });
    return grant.id;
  });
  const [done] = await db().execute<{ approved: boolean }>(sql`select kalendr_device_approve(${found.id}, ${context.tenantId}, ${grantId}) as approved`);
  if (!done?.approved) {
    // The code ran out between lookup and approval; the grant made for it must not stay open.
    await withTenant(context.tenantId, (transaction) => transaction.update(oauthGrants).set({ revokedAt: new Date() }).where(sql`${oauthGrants.tenantId} = ${context.tenantId} and ${oauthGrants.id} = ${grantId}`));
    throw new ApiError(410, "code_expired", "That code ran out. Start again in the extension.");
  }
  return { approved: true };
}
