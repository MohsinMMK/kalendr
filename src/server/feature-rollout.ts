import "server-only";

import { sql } from "drizzle-orm";

import { getDatabase, withTenant } from "@/db/client";
import { layeredFeature, ownFeatureSwitch } from "@/lib/feature-layers";

async function loadOwnFeatures(tenantId: string): Promise<unknown> {
  const [row] = await withTenant(tenantId, (transaction) => transaction.execute<{ features: unknown }>(sql`select features from tenants where id = ${tenantId}`));
  return row?.features ?? {};
}

/**
 * Whether a feature is on for one business. The business's own explicit switch in `tenants.features` wins when it has
 * one; otherwise the platform rollout (off, listed, percent, all) decides through `kalendr_rollout_enabled`. Pass
 * `tenantFeatures` when the row is already loaded to save a query.
 */
export async function featureEnabledFor(tenantId: string, featureKey: string, tenantFeatures?: unknown): Promise<boolean> {
  const own = tenantFeatures !== undefined ? tenantFeatures : await loadOwnFeatures(tenantId);
  const explicit = ownFeatureSwitch(own, featureKey);
  if (explicit !== null) return explicit;
  const database = getDatabase();
  if (!database) return layeredFeature(own, featureKey, false);
  const rows = await database.execute<{ enabled: boolean }>(sql`select kalendr_rollout_enabled(${featureKey}, ${tenantId}) as enabled`);
  return layeredFeature(own, featureKey, rows[0]?.enabled === true);
}
