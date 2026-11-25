import "server-only";

import { and, desc, eq, isNull } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditEvents, oauthClients, oauthGrants, oauthTokens } from "@/db/schema";
import { isApiScope } from "@/lib/api-scopes";
import { createClientInput, type OAuthClientView } from "@/lib/oauth";
import { ApiError } from "@/server/api-error";
import { requireFeature } from "@/server/entitlements";
import { requirePermission, requireRecentStepUp, type StaffContext } from "@/server/staff-context";

import { hashToken, newToken } from "./tokens";

/** Apps a business registers for its own software (feature 55). Owner only, behind a fresh second-factor check. */

const maxActiveClients = 10;
const secretPrefixLength = 10;

type Row = typeof oauthClients.$inferSelect;

function view(row: Row): OAuthClientView {
  return {
    id: row.id,
    name: row.name,
    redirectUris: row.redirectUris,
    scopes: row.scopes.filter(isApiScope),
    secretPrefix: row.secretPrefix,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export async function listClients(context: StaffContext): Promise<{ clients: OAuthClientView[] }> {
  requirePermission(context, "api.manage");
  if (context.preview) return { clients: [] };
  const rows = await withTenant(context.tenantId, (transaction) => transaction.select().from(oauthClients)
    .where(eq(oauthClients.tenantId, context.tenantId)).orderBy(desc(oauthClients.createdAt)).limit(100));
  return { clients: rows.map(view) };
}

/** The client id is the row id. The secret is returned once; only its hash is kept. */
export async function createClient(context: StaffContext, body: unknown): Promise<{ client: OAuthClientView; secret: string }> {
  requirePermission(context, "api.manage");
  if (context.role !== "owner") throw new ApiError(403, "owner_only", "Only the owner can register an app. Ask the owner to do it.");
  if (context.preview) throw new ApiError(409, "preview_only", "Apps can't be registered in the preview.");
  requireFeature(context, "api");
  const parsed = createClientInput.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "validation_error", "Please check the highlighted fields.", parsed.error.flatten().fieldErrors);
  requireRecentStepUp(context);
  const input = parsed.data;
  const secret = newToken("secret");
  const row = await withTenant(context.tenantId, async (transaction) => {
    const active = await transaction.select({ id: oauthClients.id }).from(oauthClients)
      .where(and(eq(oauthClients.tenantId, context.tenantId), isNull(oauthClients.revokedAt))).limit(maxActiveClients + 1);
    if (active.length >= maxActiveClients) throw new ApiError(409, "too_many_apps", `You can have ${maxActiveClients} registered apps. Remove one you no longer use first.`);
    const [created] = await transaction.insert(oauthClients).values({
      tenantId: context.tenantId,
      name: input.name,
      redirectUris: [...new Set(input.redirectUris)],
      scopes: [...new Set(input.scopes)],
      secretHash: hashToken(secret),
      secretPrefix: secret.slice(0, secretPrefixLength),
      createdByUserId: context.userId,
    }).returning();
    if (!created) throw new ApiError(500, "app_not_created", "The app could not be registered. Try again.");
    // Ids and fixed lists only: never the free-text name, never the secret.
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "oauth_client.created", outcome: "success",
      metadata: { clientId: created.id, scopes: created.scopes },
    });
    return created;
  });
  return { client: view(row), secret };
}

/** Removes the app and, in the same step, every approval and token it holds. Doing it twice is fine. */
export async function revokeClient(context: StaffContext, id: string): Promise<{ client: OAuthClientView }> {
  requirePermission(context, "api.manage");
  if (context.preview) throw new ApiError(409, "preview_only", "Apps can't be changed in the preview.");
  const row = await withTenant(context.tenantId, async (transaction) => {
    const [existing] = await transaction.select().from(oauthClients)
      .where(and(eq(oauthClients.tenantId, context.tenantId), eq(oauthClients.id, id))).limit(1);
    if (!existing) throw new ApiError(404, "not_found", "That app was not found.");
    if (existing.revokedAt) return existing;
    const now = new Date();
    const [updated] = await transaction.update(oauthClients).set({ revokedAt: now })
      .where(and(eq(oauthClients.tenantId, context.tenantId), eq(oauthClients.id, id))).returning();
    const grants = await transaction.update(oauthGrants).set({ revokedAt: now })
      .where(and(eq(oauthGrants.tenantId, context.tenantId), eq(oauthGrants.clientKind, "custom"), eq(oauthGrants.clientId, id), isNull(oauthGrants.revokedAt)))
      .returning({ id: oauthGrants.id });
    for (const grant of grants) {
      await transaction.update(oauthTokens).set({ revokedAt: now })
        .where(and(eq(oauthTokens.tenantId, context.tenantId), eq(oauthTokens.grantId, grant.id), isNull(oauthTokens.revokedAt)));
    }
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "oauth_client.revoked", outcome: "success",
      metadata: { clientId: id, grantsRevoked: grants.length },
    });
    return updated ?? existing;
  });
  return { client: view(row) };
}
