import "server-only";

import { and, desc, eq, isNull } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditEvents, oauthGrants, oauthTokens } from "@/db/schema";
import { isApiScope } from "@/lib/api-scopes";
import type { OAuthGrantView } from "@/lib/oauth";
import { ApiError } from "@/server/api-error";
import { can, requirePermission, type StaffContext } from "@/server/staff-context";

/**
 * Approvals people have given apps. Everyone sees and can revoke their own; someone who manages apps sees and can
 * revoke every person's. Revoking is immediate: the token lookup joins the grant, so the next request is refused.
 */

type Row = typeof oauthGrants.$inferSelect;

function view(row: Row): OAuthGrantView {
  return {
    id: row.id,
    clientName: row.clientName,
    clientKind: row.clientKind === "custom" ? "custom" : "builtin",
    userId: row.userId,
    scopes: row.scopes.filter(isApiScope),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export async function listGrants(context: StaffContext): Promise<{ grants: (OAuthGrantView & { mine: boolean })[] }> {
  if (context.preview || !context.userId) return { grants: [] };
  const everyone = can(context, "apps.manage");
  const rows = await withTenant(context.tenantId, (transaction) => transaction.select().from(oauthGrants)
    .where(and(eq(oauthGrants.tenantId, context.tenantId), isNull(oauthGrants.revokedAt), everyone ? undefined : eq(oauthGrants.userId, context.userId ?? "")))
    .orderBy(desc(oauthGrants.createdAt)).limit(200));
  return { grants: rows.map((row) => ({ ...view(row), mine: row.userId === context.userId })) };
}

export async function revokeGrant(context: StaffContext, id: string): Promise<{ grant: OAuthGrantView }> {
  if (context.preview) throw new ApiError(409, "preview_only", "Connected apps can't be changed in the preview.");
  const row = await withTenant(context.tenantId, async (transaction) => {
    const [existing] = await transaction.select().from(oauthGrants)
      .where(and(eq(oauthGrants.tenantId, context.tenantId), eq(oauthGrants.id, id))).limit(1);
    if (!existing) throw new ApiError(404, "not_found", "That connection was not found.");
    if (existing.userId !== context.userId) requirePermission(context, "apps.manage");
    if (existing.revokedAt) return existing;
    const now = new Date();
    const [updated] = await transaction.update(oauthGrants).set({ revokedAt: now })
      .where(and(eq(oauthGrants.tenantId, context.tenantId), eq(oauthGrants.id, id))).returning();
    await transaction.update(oauthTokens).set({ revokedAt: now })
      .where(and(eq(oauthTokens.tenantId, context.tenantId), eq(oauthTokens.grantId, id), isNull(oauthTokens.revokedAt)));
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "oauth_grant.revoked", outcome: "success",
      metadata: { grantId: id, clientKind: existing.clientKind, clientId: existing.clientId, ownGrant: existing.userId === context.userId },
    });
    return updated ?? existing;
  });
  return { grant: view(row) };
}
