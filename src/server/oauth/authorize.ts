import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditEvents, oauthClients, oauthCodes, oauthGrants } from "@/db/schema";
import { isApiScope, type ApiScope } from "@/lib/api-scopes";
import {
  authorizeQuery, builtinClientById, CODE_SECONDS, describeScopes, isAllowedRedirect, parseScopeList,
  type AuthorizeQuery, type ConsentView,
} from "@/lib/oauth";
import type { Permission } from "@/lib/permissions";
import { ApiError } from "@/server/api-error";
import { requirePermission, type StaffContext } from "@/server/staff-context";

import { hashToken, newToken } from "./tokens";

/**
 * The approval step of OAuth (feature 55). A signed-in person is shown what an app asks for and says yes or no. The
 * server decides what the app really gets: the scopes it may ask for, cut down to what this person may do themselves,
 * so approving an app never lets someone hand it more power than they have.
 */

/** What a person needs to be able to do to hand an app each scope. Scopes not listed need the API permission. */
const scopePermission: Partial<Record<ApiScope, Permission>> = {
  "services:read": "profile.own",
  "bookings:today": "schedule.read",
  "links:write": "services.manage",
};

interface Resolved {
  clientKind: "builtin" | "custom";
  clientId: string;
  clientName: string;
  clientDescription: string | null;
  allowedScopes: readonly ApiScope[];
}

function invalid(message: string): ApiError {
  return new ApiError(400, "invalid_authorization_request", message);
}

async function resolveClient(context: StaffContext, query: AuthorizeQuery): Promise<Resolved> {
  const builtin = builtinClientById(query.client_id);
  if (builtin) {
    if (!builtin.redirectPattern.test(query.redirect_uri)) throw invalid("This app asked to send you to an address we don't recognise, so we stopped.");
    return { clientKind: "builtin", clientId: builtin.id, clientName: builtin.name, clientDescription: builtin.description, allowedScopes: builtin.scopes };
  }
  const [client] = await withTenant(context.tenantId, (transaction) => transaction.select().from(oauthClients)
    .where(and(eq(oauthClients.tenantId, context.tenantId), eq(oauthClients.id, query.client_id), isNull(oauthClients.revokedAt))).limit(1));
  if (!client) throw invalid("This app is not registered for your business, so it can't ask for access.");
  // Exact match only: a prefix or a pattern is how codes end up on someone else's page.
  if (!client.redirectUris.includes(query.redirect_uri) || !isAllowedRedirect(query.redirect_uri)) {
    throw invalid("This app asked to send you to an address it has not registered, so we stopped.");
  }
  return { clientKind: "custom", clientId: client.id, clientName: client.name, clientDescription: null, allowedScopes: client.scopes.filter(isApiScope) };
}

/** Cuts a list of scopes down to the ones this person could use themselves. Nothing left is a refusal. */
/** The scopes from this list that someone with these permissions may hold. Checked again on every request with a token. */
export function scopesWithin(permissions: readonly Permission[], scopes: readonly ApiScope[]): ApiScope[] {
  return scopes.filter((scope) => permissions.includes(scopePermission[scope] ?? "api.manage"));
}

export function limitToPermissions(context: StaffContext, scopes: readonly ApiScope[]): ApiScope[] {
  const permitted = scopesWithin(context.permissions, scopes);
  if (permitted.length === 0) throw new ApiError(403, "forbidden", "You don't have permission to give this app access. Ask the owner.");
  return permitted;
}

function effectiveScopes(context: StaffContext, resolved: Resolved, requested: ApiScope[] | null): ApiScope[] {
  const wanted = requested && requested.length > 0 ? requested : [...resolved.allowedScopes];
  const outside = wanted.filter((scope) => !resolved.allowedScopes.includes(scope));
  if (outside.length > 0) throw invalid("This app asked for more than it is allowed to. Nothing was shared.");
  return limitToPermissions(context, wanted);
}

export interface PreparedConsent {
  consent: ConsentView;
  query: AuthorizeQuery;
}

export async function prepareConsent(context: StaffContext, rawQuery: unknown): Promise<PreparedConsent> {
  if (context.preview || !context.userId) throw new ApiError(409, "preview_only", "Apps can't be connected in the preview.");
  const parsed = authorizeQuery.safeParse(rawQuery);
  if (!parsed.success) throw invalid("This link is not a valid request from an app. Go back to the app and try again.");
  const query = parsed.data;
  const requested = parseScopeList(query.scope);
  if (requested === null) throw invalid("This app asked for something that does not exist. Nothing was shared.");
  const resolved = await resolveClient(context, query);
  const scopes = effectiveScopes(context, resolved, requested);
  return {
    query,
    consent: {
      clientName: resolved.clientName,
      clientDescription: resolved.clientDescription,
      scopes: describeScopes(scopes),
      redirectHost: new URL(query.redirect_uri).host,
    },
  };
}

function redirectWith(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url.toString();
}

/** Says yes or no. Returns where the browser goes next. A yes makes the approval and a ten-minute, one-use code. */
export async function decideConsent(context: StaffContext, rawQuery: unknown, approve: boolean): Promise<{ redirectTo: string }> {
  const { query } = await prepareConsent(context, rawQuery);
  if (!approve) return { redirectTo: redirectWith(query.redirect_uri, { error: "access_denied", state: query.state }) };
  const resolved = await resolveClient(context, query);
  if (resolved.clientKind === "custom") requirePermission(context, "api.manage");
  const scopes = effectiveScopes(context, resolved, parseScopeList(query.scope));
  const userId = context.userId;
  if (!userId) throw new ApiError(409, "preview_only", "Apps can't be connected in the preview.");
  const code = newToken("code");
  await withTenant(context.tenantId, async (transaction) => {
    const now = new Date();
    // One live approval per person and app: approving again replaces the old one instead of piling up.
    await transaction.update(oauthGrants).set({ revokedAt: now }).where(and(
      eq(oauthGrants.tenantId, context.tenantId), eq(oauthGrants.userId, userId), eq(oauthGrants.clientKind, resolved.clientKind),
      eq(oauthGrants.clientId, resolved.clientId), isNull(oauthGrants.revokedAt),
    ));
    const [grant] = await transaction.insert(oauthGrants).values({
      tenantId: context.tenantId, clientKind: resolved.clientKind, clientId: resolved.clientId, clientName: resolved.clientName, userId, scopes,
    }).returning({ id: oauthGrants.id });
    if (!grant) throw new ApiError(500, "grant_not_created", "The connection could not be made. Try again.");
    await transaction.insert(oauthCodes).values({
      tenantId: context.tenantId, grantId: grant.id, codeHash: hashToken(code), codeChallenge: query.code_challenge,
      redirectUri: query.redirect_uri, expiresAt: new Date(now.getTime() + CODE_SECONDS * 1_000),
    });
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: userId, actorType: "staff", action: "oauth_grant.created", outcome: "success",
      metadata: { grantId: grant.id, clientKind: resolved.clientKind, clientId: resolved.clientId, scopes },
    });
  });
  return { redirectTo: redirectWith(query.redirect_uri, { code, state: query.state }) };
}
