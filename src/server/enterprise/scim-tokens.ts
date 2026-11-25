import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { and, desc, eq, isNull } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditEvents, scimTokens } from "@/db/schema";
import type { ScimTokenView } from "@/lib/enterprise-contracts";
import { ApiError } from "@/server/api-error";
import type { StaffContext } from "@/server/staff-context";

import { guardOrgRead, guardOrgWrite } from "./guard";

const maxActiveTokens = 5;
const tokenPattern = /^kscim_[A-Za-z0-9_-]{43}$/;

export function hashScimToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function looksLikeScimToken(token: string): boolean {
  return tokenPattern.test(token);
}

function view(row: typeof scimTokens.$inferSelect): ScimTokenView {
  return {
    id: row.id, name: row.name, prefix: row.prefix, defaultRole: row.defaultRole as ScimTokenView["defaultRole"],
    createdAt: row.createdAt.toISOString(), lastUsedAt: row.lastUsedAt?.toISOString() ?? null, revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export async function listScimTokens(context: StaffContext): Promise<ScimTokenView[]> {
  guardOrgRead(context);
  if (context.preview) return [];
  return withTenant(context.tenantId, async (transaction) =>
    (await transaction.select().from(scimTokens).where(eq(scimTokens.tenantId, context.tenantId)).orderBy(desc(scimTokens.createdAt))).map(view));
}

/** Makes a directory token. The token is returned once; only its hash is kept. */
export async function createScimToken(context: StaffContext, input: { name: string; defaultRole: ScimTokenView["defaultRole"] }): Promise<ScimTokenView> {
  guardOrgWrite(context, { plan: true, stepUp: true });
  // 256 random bits; the visible prefix is only to tell tokens apart on screen.
  const secret = randomBytes(32).toString("base64url");
  const token = `kscim_${secret}`;
  return withTenant(context.tenantId, async (transaction) => {
    const active = await transaction.select({ id: scimTokens.id }).from(scimTokens).where(and(eq(scimTokens.tenantId, context.tenantId), isNull(scimTokens.revokedAt)));
    if (active.length >= maxActiveTokens) throw new ApiError(409, "too_many_tokens", `You can have ${maxActiveTokens} active tokens. Revoke one first.`);
    const [row] = await transaction.insert(scimTokens).values({
      tenantId: context.tenantId, name: input.name, tokenHash: hashScimToken(token), prefix: token.slice(0, 12), defaultRole: input.defaultRole, createdByUserId: context.userId,
    }).returning();
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "enterprise.scim.token_created", outcome: "success", metadata: { tokenId: row!.id, defaultRole: input.defaultRole },
    });
    return { ...view(row!), token };
  });
}

export async function revokeScimToken(context: StaffContext, tokenId: string): Promise<ScimTokenView> {
  guardOrgWrite(context, { plan: true, stepUp: true });
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.update(scimTokens).set({ revokedAt: new Date() })
      .where(and(eq(scimTokens.tenantId, context.tenantId), eq(scimTokens.id, tokenId), isNull(scimTokens.revokedAt))).returning();
    if (!row) throw new ApiError(404, "token_not_found", "That token could not be found, or it was already revoked.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "enterprise.scim.token_revoked", outcome: "success", metadata: { tokenId },
    });
    return view(row);
  });
}
