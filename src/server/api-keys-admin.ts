import "server-only";

import { and, count, desc, eq, isNull, or, gt } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { apiKeys, auditEvents } from "@/db/schema";
import { isApiScope } from "@/lib/api-scopes";

import { ApiError } from "./api-error";
import { generateApiKey } from "./api-key-context";
import { apiKeyIdSchema, createApiKeyInput, maxActiveApiKeys, type ApiKeyView, type CreatedApiKey } from "./api-keys-contracts";
import { requireFeature } from "./entitlements";
import { requirePermission, requireRecentStepUp, type StaffContext } from "./staff-context";

type Row = typeof apiKeys.$inferSelect;

function view(row: Row): ApiKeyView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes.filter(isApiScope),
    mode: row.mode === "test" ? "test" : "live",
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listApiKeys(context: StaffContext): Promise<{ keys: ApiKeyView[] }> {
  requirePermission(context, "api.manage");
  if (context.preview) return { keys: [] };
  const rows = await withTenant(context.tenantId, (transaction) => transaction.select().from(apiKeys)
    .where(eq(apiKeys.tenantId, context.tenantId)).orderBy(desc(apiKeys.createdAt)).limit(200));
  return { keys: rows.map(view) };
}

/**
 * Makes a key. Only the owner may, and only right after a second-factor check, because a key can read every
 * customer. The key itself is returned once; the table keeps its hash and a short prefix.
 */
export async function createApiKey(context: StaffContext, body: unknown): Promise<CreatedApiKey> {
  requirePermission(context, "api.manage");
  if (context.role !== "owner") throw new ApiError(403, "owner_only", "Only the owner can create an API key. Ask the owner to make one for you.");
  if (context.preview) throw new ApiError(409, "preview_only", "API keys can't be created in the preview.");
  // The API, the MCP server's staff tools and the developer keys come with the Growth plan and up.
  requireFeature(context, "api");
  const parsed = createApiKeyInput.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, "validation_error", "Please check the highlighted fields.", parsed.error.flatten().fieldErrors);
  }
  const input = parsed.data;
  requireRecentStepUp(context);
  const generated = generateApiKey(input.mode);
  const row = await withTenant(context.tenantId, async (transaction) => {
    const [active] = await transaction.select({ total: count() }).from(apiKeys).where(and(
      eq(apiKeys.tenantId, context.tenantId),
      isNull(apiKeys.revokedAt),
      or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
    ));
    if ((active?.total ?? 0) >= maxActiveApiKeys) {
      throw new ApiError(409, "too_many_keys", `You can have ${maxActiveApiKeys} active keys. Revoke one you no longer use first.`);
    }
    const [created] = await transaction.insert(apiKeys).values({
      tenantId: context.tenantId,
      name: input.name,
      prefix: generated.prefix,
      keyHash: generated.keyHash,
      scopes: [...input.scopes],
      mode: input.mode,
      createdByUserId: context.userId,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    }).returning();
    if (!created) throw new ApiError(500, "api_key_not_created", "The key could not be created. Try again.");
    // Metadata holds ids and names from fixed lists only: never the key and never the free-text name.
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      actorType: "staff",
      action: "api_key.created",
      outcome: "success",
      metadata: { keyId: created.id, prefix: created.prefix, mode: created.mode, scopes: [...input.scopes] },
    });
    return created;
  });
  return { key: view(row), secret: generated.key };
}

/** Revoking stops the key on its very next request. Doing it twice is fine. */
export async function revokeApiKey(context: StaffContext, id: string): Promise<{ key: ApiKeyView }> {
  requirePermission(context, "api.manage");
  if (context.preview) throw new ApiError(409, "preview_only", "API keys can't be changed in the preview.");
  const parsedId = apiKeyIdSchema.safeParse(id);
  if (!parsedId.success) throw new ApiError(404, "not_found", "That key was not found.");
  const row = await withTenant(context.tenantId, async (transaction) => {
    const [existing] = await transaction.select().from(apiKeys).where(and(eq(apiKeys.tenantId, context.tenantId), eq(apiKeys.id, parsedId.data))).limit(1);
    if (!existing) throw new ApiError(404, "not_found", "That key was not found.");
    if (existing.revokedAt) return existing;
    const [updated] = await transaction.update(apiKeys).set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.tenantId, context.tenantId), eq(apiKeys.id, existing.id), isNull(apiKeys.revokedAt))).returning();
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      actorType: "staff",
      action: "api_key.revoked",
      outcome: "success",
      metadata: { keyId: existing.id, prefix: existing.prefix, mode: existing.mode, scopes: existing.scopes },
    });
    return updated ?? existing;
  });
  return { key: view(row) };
}
