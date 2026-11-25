import type { BillingPlanView, BillingState } from "@/lib/billing-contracts";
import type { PlanKey } from "@/lib/entitlements";
import { formatMoney } from "@/lib/money";

const dayMs = 86_400_000;

/** Whole days from `now` until `iso`, counting a part day as a day. Never below 0. */
export function daysUntil(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.ceil((time - now.getTime()) / dayMs));
}

/** "3 Dec", or "3 Dec 2027" when it is not this year. */
export function shortDate(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }).format(date);
}

export function money(minor: number, currency: string): string {
  return formatMoney(minor, currency, currency === "USD" ? "en-US" : "en-IN");
}

export function priceText(plan: Pick<BillingPlanView, "priceMinor" | "currency">): string {
  return plan.priceMinor === 0 ? "Free" : `${money(plan.priceMinor, plan.currency)} a month`;
}

export function planName(state: Pick<BillingState, "plans">, key: PlanKey): string {
  return state.plans.find((plan) => plan.key === key)?.name ?? key.charAt(0).toUpperCase() + key.slice(1);
}

export function limitText(limit: number | null, noun: string, nounPlural: string): string {
  if (limit === null) return `Unlimited ${nounPlural}`;
  return `${limit} ${limit === 1 ? noun : nounPlural}`;
}

/** A line per thing a plan includes, from the numbers the server sent. */
export function planLines(plan: BillingPlanView, words: { practitioner: string; practitioners: string }): string[] {
  const { limits } = plan;
  const lines = [
    limitText(limits.staffCalendars, `${words.practitioner} calendar`, `${words.practitioner} calendars`),
    limitText(limits.locations, "location", "locations"),
    limits.bookingsPerMonth === null ? "Unlimited bookings" : `${limits.bookingsPerMonth} bookings a month`,
    limits.messagesIncluded.whatsapp + limits.messagesIncluded.sms > 0
      ? `${limits.messagesIncluded.whatsapp.toLocaleString("en-IN")} WhatsApp and ${limits.messagesIncluded.sms.toLocaleString("en-IN")} text messages a month`
      : "Email reminders only",
  ];
  if (limits.features.onlinePayments) lines.push("Online payments");
  if (limits.features.customDomain) lines.push("Your own web address, no Kalendr badge");
  if (limits.features.calendarSync !== "none") lines.push(limits.features.calendarSync === "full" ? "Calendar sync" : "Calendar sync, limited");
  if (limits.features.reports) lines.push("Reports");
  return lines;
}

export type PlanAction =
  | { kind: "current"; label: string }
  | { kind: "scheduled"; label: string }
  | { kind: "none"; label: string }
  | { kind: "checkout" | "upgrade" | "downgrade" | "cancel" | "resume"; label: string };

/** Whether a paid subscription exists to change (as opposed to starting one with checkout). */
export function hasPaidSubscription(state: BillingState): boolean {
  const { status, reason } = state.plan;
  return status === "active" || status === "paused" || status === "past_due" || (status === "cancelled" && reason === "paid");
}

/** What the button on one plan card does, from where the business stands. Pure, so every case can be tested. */
export function planActionFor(state: BillingState, target: BillingPlanView): PlanAction {
  const { plan } = state;
  const price = (key: PlanKey) => state.plans.find((item) => item.key === key)?.priceMinor ?? 0;
  const paid = hasPaidSubscription(state);
  if (!paid) {
    if (target.key === "free") return plan.key === "free" ? { kind: "current", label: "Current plan" } : { kind: "none", label: plan.status === "trialing" ? "After the trial" : "Free" };
    if (plan.status === "trialing" && plan.key === target.key) return { kind: "checkout", label: "Keep this plan" };
    return { kind: "checkout", label: plan.key === "free" ? "Choose plan" : "Upgrade" };
  }
  if (target.key === plan.key) {
    if (plan.cancelAtPeriodEnd || plan.status === "cancelled") return { kind: "resume", label: "Keep my plan" };
    if (plan.status === "past_due") return { kind: "checkout", label: "Update payment" };
    return { kind: "current", label: "Current plan" };
  }
  if (plan.pendingPlanKey === target.key) return { kind: "scheduled", label: "Scheduled" };
  if (target.key === "free") return { kind: "cancel", label: "Cancel plan" };
  return target.priceMinor > price(plan.key) ? { kind: "upgrade", label: "Upgrade" } : { kind: "downgrade", label: "Downgrade at period end" };
}

export type UsageLevel = "none" | "ok" | "near" | "over";

export interface UsageView {
  metric: string;
  label: string;
  used: number;
  included: number | null;
  percent: number;
  level: UsageLevel;
  /** Said in words as well as drawn, so colour is never the only signal. */
  status: string;
}

const metricLabels: Record<string, string> = {
  whatsapp: "WhatsApp messages",
  sms: "Text messages",
  email: "Emails",
  bookings: "Bookings this month",
  bookingsPerMonth: "Bookings this month",
};

export function metricLabel(metric: string): string {
  return metricLabels[metric] ?? metric.replace(/[_-]+/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

export function usageView(usage: BillingState["usage"][number]): UsageView {
  const { metric, used, included } = usage;
  const label = metricLabel(metric);
  if (included === null) return { metric, label, used, included, percent: 0, level: "none", status: `${used.toLocaleString("en-IN")} used` };
  const percent = included === 0 ? (used > 0 ? 100 : 0) : Math.min(100, Math.round((used / included) * 100));
  const level: UsageLevel = included === 0 ? (used > 0 ? "over" : "ok") : used >= included ? "over" : used / included >= 0.8 ? "near" : "ok";
  const status = included === 0 && used === 0 ? "Not included in your plan" : level === "over" ? "All used" : level === "near" ? "Almost used up" : "";
  return { metric, label, used, included, percent, level, status };
}
