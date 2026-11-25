import "server-only";

import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getDatabase, withTenant } from "@/db/client";
import { auditEvents, tenants } from "@/db/schema";
import { brandSettingsSchema, defaultBrand, parseBrand, readAccent, type BrandSettings } from "@/lib/brand-theme";
import { canUse } from "@/lib/entitlements";

import { ApiError } from "./api-error";
import { loadEntitlements, requireFeature } from "./entitlements";
import { loadMediaUrlsIn } from "./media";
import { assertNotReadOnlyImpersonation, requirePermission, type StaffContext } from "./staff-context";

/**
 * The business's look (feature 13). Logo and cover are saved through the media route; this stores the accent colour,
 * the corner style and the hide-badge switch on `tenants.brand`. Hiding the badge is a paid feature, and it is checked
 * on read as well as on write, so a business whose plan lapses shows the badge again without anyone editing anything.
 */

export const brandUpdateSchema = z.strictObject(brandSettingsSchema.shape);

export interface StaffBrand {
  settings: BrandSettings;
  /** What the owner is told about the chosen colour (for example, that dark text is used on a light colour). */
  notes: string[];
  logoUrl: string | null;
  coverUrl: string | null;
  /** Whether this plan may hide the Kalendr badge. */
  canHideBadge: boolean;
}

/** The brand a public page uses: the stored one, with the badge flag held to what the plan allows. */
export function effectiveBrand(stored: unknown, plan: Parameters<typeof canUse>[0] | undefined): BrandSettings {
  const brand = parseBrand(stored);
  return { ...brand, hideBadge: brand.hideBadge && (!plan || canUse(plan, "removeBadge")) };
}

export async function loadStaffBrand(context: StaffContext): Promise<StaffBrand> {
  requirePermission(context, "settings.manage");
  if (context.preview) return { settings: defaultBrand, notes: [], logoUrl: null, coverUrl: null, canHideBadge: true };
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.select({ brand: tenants.brand }).from(tenants).where(eq(tenants.id, context.tenantId)).limit(1);
    const pictures = await loadMediaUrlsIn(transaction, context.tenantId, context.clinicSlug);
    const settings = parseBrand(row?.brand);
    return {
      settings,
      notes: settings.accent ? readAccent(settings.accent).notes : [],
      logoUrl: pictures.logoUrl,
      coverUrl: pictures.coverUrl,
      canHideBadge: context.entitlements ? canUse(context.entitlements, "removeBadge") : true,
    };
  });
}

export async function saveBrand(context: StaffContext, input: BrandSettings): Promise<StaffBrand> {
  requirePermission(context, "settings.manage");
  assertNotReadOnlyImpersonation(context);
  if (context.preview) throw new ApiError(409, "preview_mode", "Branding is not saved in the preview.");
  const next = brandSettingsSchema.parse(input);
  await withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.select({ brand: tenants.brand }).from(tenants).where(eq(tenants.id, context.tenantId)).limit(1).for("update");
    const before = parseBrand(row?.brand);
    // The plan is read inside the transaction so a downgrade a moment ago is respected.
    const { entitlements } = await loadEntitlements(context.tenantId, transaction);
    if (next.hideBadge && !before.hideBadge) requireFeature({ entitlements }, "removeBadge");
    await transaction.update(tenants).set({ brand: next, updatedAt: new Date() }).where(eq(tenants.id, context.tenantId));
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      actorType: "staff",
      action: "brand.updated",
      outcome: "success",
      // Only what changed, never free text. The accent is a colour code, not personal data.
      metadata: { accentChanged: before.accent !== next.accent, cornersChanged: before.corners !== next.corners, hideBadge: next.hideBadge },
    });
  });
  return loadStaffBrand(context);
}

/** The brand public pages outside the catalog use (manage, offer, pay, portal), by business id. Never throws: a page keeps Kalendr's look if this fails. */
export async function loadPublicBrand(tenantId: string): Promise<BrandSettings | undefined> {
  try {
    return await withTenant(tenantId, async (transaction) => {
      const [row] = await transaction.select({ brand: tenants.brand }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
      if (!row) return undefined;
      return effectiveBrand(row.brand, (await loadEntitlements(tenantId, transaction)).entitlements);
    });
  } catch {
    return undefined;
  }
}

/** Same, by the business's address name, for pages whose address carries the slug. */
export async function loadPublicBrandBySlug(slug: string): Promise<BrandSettings | undefined> {
  try {
    const database = getDatabase();
    if (!database) return undefined;
    const [resolved] = await database.execute<{ tenant_id: string }>(sql`select tenant_id from kalendr_resolve_tenant(${slug}, null)`);
    return resolved ? await loadPublicBrand(resolved.tenant_id) : undefined;
  } catch {
    return undefined;
  }
}
