import type { BillingPlanView, PlanLimitDetails } from "@/lib/billing-contracts";
import { planDefinitions, type PlanKey } from "@/lib/entitlements";

import { limitText } from "./billing-format";

export interface UpgradeWords {
  practitioner: string;
  practitioners: string;
}

const featureNames: Record<string, string> = {
  onlinePayments: "online payments",
  customDomain: "your own web address",
  removeBadge: "removing the Kalendr badge",
  calendarSync: "calendar sync",
  reports: "reports",
  api: "the API",
  assistant: "the assistant",
  enterprise: "company sign-in, directory sync and custom roles",
  whatsapp: "WhatsApp messages",
  sms: "text messages",
};

function numeric(subject: string, words: UpgradeWords): { noun: string; plural: string; pick: (plan: BillingPlanView["limits"]) => number | null } | null {
  switch (subject) {
    case "staffCalendars": return { noun: `${words.practitioner} calendar`, plural: `${words.practitioner} calendars`, pick: (limits) => limits.staffCalendars };
    case "locations": return { noun: "location", plural: "locations", pick: (limits) => limits.locations };
    case "bookingsPerMonth": return { noun: "booking a month", plural: "bookings a month", pick: (limits) => limits.bookingsPerMonth };
    default: return null;
  }
}

const planLabel = (plans: readonly BillingPlanView[], key: PlanKey) => plans.find((plan) => plan.key === key)?.name ?? planDefinitions[key].name;
const limitsOf = (plans: readonly BillingPlanView[], key: PlanKey) => plans.find((plan) => plan.key === key)?.limits ?? planDefinitions[key].limits;

/** "Your Starter plan includes 3 staff calendars. Growth includes 10." For a feature: "Your Free plan does not include online payments. Starter does." */
export function upgradeMessage(details: PlanLimitDetails, plans: readonly BillingPlanView[], words: UpgradeWords): string {
  if (details.subject === "plan") return "Your current plan does not include this.";
  const current = planLabel(plans, details.currentPlan);
  const count = numeric(details.subject, words);
  if (count) {
    const have = count.pick(limitsOf(plans, details.currentPlan)) ?? details.limit;
    const first = have === null ? `Your ${current} plan has no limit on this.` : `Your ${current} plan includes ${limitText(have, count.noun, count.plural)}.`;
    if (!details.requiredPlan) return `${first} No plan includes more.`;
    const more = count.pick(limitsOf(plans, details.requiredPlan));
    return `${first} ${planLabel(plans, details.requiredPlan)} includes ${more === null ? `unlimited ${count.plural}` : more}.`;
  }
  const feature = featureNames[details.subject];
  if (!feature) return details.requiredPlan ? `This is not part of your ${current} plan. ${planLabel(plans, details.requiredPlan)} includes it.` : `This is not part of your ${current} plan.`;
  return details.requiredPlan ? `Your ${current} plan does not include ${feature}. ${planLabel(plans, details.requiredPlan)} does.` : `Your ${current} plan does not include ${feature}.`;
}

/** A small badge on a plan-locked control: the cheapest plan that unlocks it, such as "Growth". */
export function lockedBadge(feature: keyof typeof featureNames, plans: readonly BillingPlanView[] = []): string {
  const order: PlanKey[] = ["starter", "growth", "scale"];
  const key = order.find((planKey) => {
    const limits = limitsOf(plans, planKey);
    if (feature === "whatsapp") return limits.messagesIncluded.whatsapp > 0;
    if (feature === "sms") return limits.messagesIncluded.sms > 0;
    if (feature === "calendarSync") return limits.features.calendarSync === "full";
    return Boolean((limits.features as Record<string, unknown>)[feature]);
  }) ?? "growth";
  return planLabel(plans, key);
}
