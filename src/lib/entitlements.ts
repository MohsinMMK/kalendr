import { z } from "zod";

/**
 * What each plan allows (feature 14). Pure rules, no database: the server loads a business's subscription and
 * plan row, calls `resolveEntitlements`, and asks `canUse` / `withinLimit`. The `plans` table seeded by migration
 * 0043 holds the same numbers; `entitlements.integration.test.ts` keeps the two in step.
 */

export const planKeys = ["free", "starter", "growth", "scale"] as const;
export type PlanKey = (typeof planKeys)[number];
export const planKeySchema = z.enum(planKeys);

export const subscriptionStatuses = ["trialing", "active", "past_due", "paused", "cancelled", "free"] as const;
export type SubscriptionStatus = (typeof subscriptionStatuses)[number];

/** Days of full service after the first failed renewal. */
export const pastDueGraceDays = 7;
export const trialDays = 14;
/** The plan every new business tries. */
export const trialPlanKey: PlanKey = "growth";

const limitSchema = z.number().int().min(0).nullable();

export const planLimitsSchema = z.object({
  /** Practitioner calendars. null is unlimited. */
  staffCalendars: limitSchema,
  locations: limitSchema,
  bookingsPerMonth: limitSchema,
  /** Messages included each month before pay-per-message. */
  messagesIncluded: z.object({ whatsapp: z.number().int().min(0), sms: z.number().int().min(0) }),
  features: z.object({
    onlinePayments: z.boolean(),
    customDomain: z.boolean(),
    removeBadge: z.boolean(),
    calendarSync: z.enum(["none", "limited", "full"]),
    reports: z.boolean(),
    api: z.boolean(),
    assistant: z.boolean(),
    /** Company sign-in, directory sync, custom roles and verified domains (feature 53). A plan stored before this existed reads as off. */
    enterprise: z.boolean().catch(false),
  }),
});
export type PlanLimits = z.infer<typeof planLimitsSchema>;

/** Features that can be asked about with `canUse`. Email is on every plan, so it is not here. */
export const planFeatures = ["onlinePayments", "customDomain", "removeBadge", "calendarSync", "reports", "api", "assistant", "enterprise", "whatsapp", "sms", "routingForms"] as const;
export type PlanFeature = (typeof planFeatures)[number];

/** Things with a number on them, asked about with `withinLimit`. */
export const planMetrics = ["staffCalendars", "locations", "bookingsPerMonth"] as const;
export type PlanMetric = (typeof planMetrics)[number];

export interface PlanDefinition {
  key: PlanKey;
  name: string;
  sortOrder: number;
  priceInrMinor: number;
  priceUsdMinor: number;
  limits: PlanLimits;
}

const features = (overrides: Partial<PlanLimits["features"]>): PlanLimits["features"] => ({
  onlinePayments: false, customDomain: false, removeBadge: false, calendarSync: "none", reports: false, api: false, assistant: false, enterprise: false, ...overrides,
});

export const planDefinitions: Record<PlanKey, PlanDefinition> = {
  free: { key: "free", name: "Free", sortOrder: 0, priceInrMinor: 0, priceUsdMinor: 0, limits: { staffCalendars: 1, locations: 1, bookingsPerMonth: 50, messagesIncluded: { whatsapp: 0, sms: 0 }, features: features({}) } },
  starter: { key: "starter", name: "Starter", sortOrder: 1, priceInrMinor: 49_900, priceUsdMinor: 900, limits: { staffCalendars: 3, locations: 1, bookingsPerMonth: null, messagesIncluded: { whatsapp: 200, sms: 100 }, features: features({ onlinePayments: true, calendarSync: "limited" }) } },
  growth: { key: "growth", name: "Growth", sortOrder: 2, priceInrMinor: 149_900, priceUsdMinor: 2_900, limits: { staffCalendars: 10, locations: 3, bookingsPerMonth: null, messagesIncluded: { whatsapp: 1000, sms: 500 }, features: features({ onlinePayments: true, customDomain: true, removeBadge: true, calendarSync: "full", reports: true, api: true, assistant: true }) } },
  scale: { key: "scale", name: "Scale", sortOrder: 3, priceInrMinor: 399_900, priceUsdMinor: 7_900, limits: { staffCalendars: null, locations: null, bookingsPerMonth: null, messagesIncluded: { whatsapp: 5000, sms: 2500 }, features: features({ onlinePayments: true, customDomain: true, removeBadge: true, calendarSync: "full", reports: true, api: true, assistant: true, enterprise: true }) } },
};

export function parsePlanLimits(value: unknown, fallback: PlanKey = "free"): PlanLimits {
  const parsed = planLimitsSchema.safeParse(value);
  return parsed.success ? parsed.data : planDefinitions[fallback].limits;
}

export interface SubscriptionFacts {
  planKey: PlanKey;
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  pendingPlanKey: PlanKey | null;
  pastDueSince: Date | null;
}

const dayMs = 86_400_000;

/**
 * The plan a business can use right now, and why. A trial gives Growth until it ends, then Free. A failed
 * renewal keeps the paid plan for 7 days, then Free. A cancelled subscription keeps its plan to the period's end.
 * Nothing is deleted: extra staff calendars become read-only (see `staffCalendarsOverLimit`).
 */
export function effectivePlanKey(subscription: SubscriptionFacts | null, now: Date = new Date()): { planKey: PlanKey; reason: "trial" | "paid" | "grace" | "free" | "trial_ended" | "grace_ended" | "cancelled" } {
  if (!subscription) return { planKey: "free", reason: "free" };
  switch (subscription.status) {
    case "trialing":
      return subscription.trialEndsAt && subscription.trialEndsAt > now ? { planKey: trialPlanKey, reason: "trial" } : { planKey: "free", reason: "trial_ended" };
    case "active":
    case "paused":
      return { planKey: subscription.planKey, reason: "paid" };
    case "past_due": {
      const since = subscription.pastDueSince;
      return since && now.getTime() - since.getTime() < pastDueGraceDays * dayMs ? { planKey: subscription.planKey, reason: "grace" } : { planKey: "free", reason: "grace_ended" };
    }
    case "cancelled":
      return subscription.currentPeriodEnd && subscription.currentPeriodEnd > now ? { planKey: subscription.planKey, reason: "paid" } : { planKey: "free", reason: "cancelled" };
    case "free":
      return { planKey: "free", reason: "free" };
  }
}

export interface Entitlements {
  planKey: PlanKey;
  planName: string;
  status: SubscriptionStatus;
  limits: PlanLimits;
  trialEndsAt: Date | null;
  /** Set while a failed renewal is in its grace period: when full service ends. */
  graceEndsAt: Date | null;
  currentPeriodEnd: Date | null;
}

export function resolveEntitlements(subscription: SubscriptionFacts | null, planRows: Partial<Record<PlanKey, unknown>> = {}, now: Date = new Date()): Entitlements {
  const { planKey } = effectivePlanKey(subscription, now);
  const limits = planRows[planKey] === undefined ? planDefinitions[planKey].limits : parsePlanLimits(planRows[planKey], planKey);
  const graceEndsAt = subscription?.status === "past_due" && subscription.pastDueSince ? new Date(subscription.pastDueSince.getTime() + pastDueGraceDays * dayMs) : null;
  return {
    planKey,
    planName: planDefinitions[planKey].name,
    status: subscription?.status ?? "free",
    limits,
    trialEndsAt: subscription?.trialEndsAt ?? null,
    graceEndsAt,
    currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
  };
}

/** The cheapest plan that allows a feature, or null when none does. Named in the upgrade prompt. */
export function planUnlocking(feature: PlanFeature): PlanKey | null {
  return planKeys.find((key) => featureAllowed(planDefinitions[key].limits, feature)) ?? null;
}

function featureAllowed(limits: PlanLimits, feature: PlanFeature): boolean {
  switch (feature) {
    case "whatsapp": return limits.messagesIncluded.whatsapp > 0;
    case "sms": return limits.messagesIncluded.sms > 0;
    case "calendarSync": return limits.features.calendarSync !== "none";
    // Routing forms (feature 46) come with the plans that have reports; a separate key lets that change without touching callers.
    case "routingForms": return limits.features.reports;
    default: return limits.features[feature];
  }
}

export function canUse(entitlements: Pick<Entitlements, "limits">, feature: PlanFeature): boolean {
  return featureAllowed(entitlements.limits, feature);
}

/** The most the plan allows for a metric, or null for unlimited. */
export function limitFor(entitlements: Pick<Entitlements, "limits">, metric: PlanMetric): number | null {
  return entitlements.limits[metric];
}

/** True when `currentCount` more is still allowed: adding one thing is fine while the count is below the limit. */
export function withinLimit(entitlements: Pick<Entitlements, "limits">, metric: PlanMetric, currentCount: number): boolean {
  const limit = limitFor(entitlements, metric);
  return limit === null || currentCount < limit;
}

/** The cheapest plan whose limit for a metric is above `needed`, or null. */
export function planForCount(metric: PlanMetric, needed: number): PlanKey | null {
  return planKeys.find((key) => { const limit = planDefinitions[key].limits[metric]; return limit === null || limit >= needed; }) ?? null;
}

/** Message usage as a share of the included amount, for the 80% and 100% alerts. */
export function usageShare(used: number, included: number): number {
  if (included <= 0) return used > 0 ? 1 : 0;
  return used / included;
}

/** Which staff calendars stay editable when a business is over its limit: the oldest ones, up to the limit. */
export function editableCalendarIds(orderedByCreation: readonly string[], limit: number | null): Set<string> {
  return new Set(limit === null ? orderedByCreation : orderedByCreation.slice(0, limit));
}
