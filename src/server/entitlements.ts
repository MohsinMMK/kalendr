import "server-only";

import { resolveEntitlements, trialPlanKey, canUse, limitFor, planForCount, planUnlocking, withinLimit, type Entitlements, type PlanFeature, type PlanMetric } from "@/lib/entitlements";
import { planLimitErrorCode } from "@/lib/billing-contracts";
import { planLimitDetails, planLimitMessage } from "@/lib/billing-rules";
import type { KalendrTransaction } from "@/db/client";
import { withTenant } from "@/db/client";

import { ApiError } from "./api-error";
import { loadBilling, type LoadedBilling } from "./billing/entitlement-loader";
import { drizzleRunner } from "./workflows/runner";

export type { Entitlements } from "@/lib/entitlements";

/** What the plan allows right now, plus the stored subscription behind it. Opens its own scope when no transaction is given. */
export async function loadEntitlements(tenantId: string, transaction?: Pick<KalendrTransaction, "execute">, now?: Date): Promise<LoadedBilling> {
  if (transaction) return loadBilling(drizzleRunner(transaction), tenantId, { now });
  return withTenant(tenantId, (scoped) => loadBilling(drizzleRunner(scoped), tenantId, { now }));
}

/** The preview business shows a Growth trial with demo data; nothing is stored. */
export function previewEntitlements(now: Date = new Date()): Entitlements {
  return resolveEntitlements({
    planKey: trialPlanKey, status: "trialing", trialEndsAt: new Date(now.getTime() + 9 * 86_400_000), currentPeriodEnd: null,
    cancelAtPeriodEnd: false, pendingPlanKey: null, pastDueSince: null,
  }, {}, now);
}

const subjectLabels: Record<PlanFeature | PlanMetric, string> = {
  onlinePayments: "Online payments",
  customDomain: "Your own web address",
  removeBadge: "Removing the Kalendr badge",
  calendarSync: "Calendar sync",
  reports: "Reports",
  api: "The API",
  assistant: "The assistant",
  enterprise: "Company sign-in, directory sync and custom roles",
  whatsapp: "WhatsApp messages",
  sms: "Text messages",
  routingForms: "Routing forms",
  staffCalendars: "More staff calendars",
  locations: "More locations",
  bookingsPerMonth: "More bookings this month",
};

/** The refusal every plan check throws. The screen opens the upgrade dialog on `plan_limit`. */
export function planLimitError(subject: PlanFeature | PlanMetric, entitlements: Pick<Entitlements, "limits" | "planKey">, count?: number): ApiError {
  const isMetric = subject === "staffCalendars" || subject === "locations" || subject === "bookingsPerMonth";
  const requiredPlan = isMetric ? planForCount(subject, (count ?? 0) + 1) : planUnlocking(subject);
  const limit = isMetric ? limitFor(entitlements, subject) : null;
  return new ApiError(402, planLimitErrorCode, planLimitMessage(subjectLabels[subject], requiredPlan, entitlements.planKey), undefined, undefined,
    { ...planLimitDetails(subject, requiredPlan, entitlements.planKey, limit) });
}

interface EntitledContext { entitlements?: Entitlements }

/** Throws 402 `plan_limit` when the plan lacks a feature. A context with no entitlements (test fixtures) is allowed through. */
export function requireFeature(context: EntitledContext, feature: PlanFeature): void {
  if (!context.entitlements || canUse(context.entitlements, feature)) return;
  throw planLimitError(feature, context.entitlements);
}

/** Throws 402 `plan_limit` when one more would pass the plan's limit. `currentCount` is how many exist now. */
export function requireWithinLimit(context: EntitledContext, metric: PlanMetric, currentCount: number): void {
  if (!context.entitlements || withinLimit(context.entitlements, metric, currentCount)) return;
  throw planLimitError(metric, context.entitlements, currentCount);
}
