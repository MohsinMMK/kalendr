/**
 * Layering of a feature switch, with no database in it so the rule is tested alone: the business's own explicit
 * switch in `tenants.features` wins when it is present; otherwise the platform rollout decides.
 */
export function ownFeatureSwitch(tenantFeatures: unknown, featureKey: string): boolean | null {
  if (typeof tenantFeatures !== "object" || tenantFeatures === null || Array.isArray(tenantFeatures)) return null;
  const own = (tenantFeatures as Record<string, unknown>)[featureKey];
  return typeof own === "boolean" ? own : null;
}

export function layeredFeature(tenantFeatures: unknown, featureKey: string, rolloutEnabled: boolean): boolean {
  return ownFeatureSwitch(tenantFeatures, featureKey) ?? rolloutEnabled;
}
