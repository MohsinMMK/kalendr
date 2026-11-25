import { channelTemplateFor, type ChannelTemplateKey } from "@/lib/channel-templates";
import { planDefinitions, planKeys, usageShare, type PlanKey, type PlanLimits } from "@/lib/entitlements";
import type { BillingProvider, PlanLimitDetails } from "@/lib/billing-contracts";

/**
 * Pure rules of subscription billing (feature 14). No database, no provider: everything here is a function of its
 * arguments so it can be tested without either. The server and the worker call these and do the reading and writing.
 */

/** GST on Kalendr's own subscription invoices, in basis points (18%). */
export const gstRateBps = 1800;

// --- Which provider a business pays through ---------------------------------------------------------------------

export interface ProviderHints {
  currency: string;
  locale: string;
  timezone: string;
}

/**
 * Businesses in India pay through Razorpay (UPI Autopay or card, in rupees); everyone else through Stripe in dollars.
 * Sign-up never asks for a country and `currency` defaults to INR, so currency alone would send everyone to Razorpay.
 * An India business is one with an Indian locale or an Indian time zone; a non-INR currency always means Stripe.
 */
export function chooseBillingProvider({ currency, locale, timezone }: ProviderHints): BillingProvider {
  if (currency.toUpperCase() !== "INR") return "stripe";
  const indianLocale = /(^|[-_])in$/i.test(locale.trim());
  const indianZone = /^asia\/(kolkata|calcutta)$/i.test(timezone.trim());
  return indianLocale || indianZone ? "razorpay" : "stripe";
}

export function billingCurrency(provider: BillingProvider): "INR" | "USD" {
  return provider === "razorpay" ? "INR" : "USD";
}

export function planPriceMinor(planKey: PlanKey, currency: "INR" | "USD"): number {
  const plan = planDefinitions[planKey];
  return currency === "INR" ? plan.priceInrMinor : plan.priceUsdMinor;
}

// --- Invoice money ----------------------------------------------------------------------------------------------

export interface InvoiceAmounts {
  amountMinor: number;
  gstRateBps: number;
  gstMinor: number;
  totalMinor: number;
}

/**
 * Splits a tax-inclusive total into the amount before GST and the GST. Razorpay charges the plan price as the full
 * amount the customer pays, so for rupees the charge already contains 18% GST: amount = round(total / 1.18) and
 * GST = total - amount. The two always add back to the total, which the table also checks.
 */
export function splitInclusiveGst(totalMinor: number, rateBps: number = gstRateBps): { amountMinor: number; gstMinor: number } {
  const amountMinor = Math.round((totalMinor * 10_000) / (10_000 + rateBps));
  return { amountMinor, gstMinor: totalMinor - amountMinor };
}

/** No GST outside India: a dollar charge is invoiced for exactly what was charged. */
export function invoiceAmounts(currency: string, totalMinor: number): InvoiceAmounts {
  if (currency.toUpperCase() !== "INR") return { amountMinor: totalMinor, gstRateBps: 0, gstMinor: 0, totalMinor };
  return { ...splitInclusiveGst(totalMinor), gstRateBps, totalMinor };
}

// --- Usage alerts -----------------------------------------------------------------------------------------------

export type UsageThreshold = 80 | 100;

/** The month a usage counter belongs to, as the first day in UTC: `2026-11-01`. */
export function usagePeriod(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** Alert markers carry the month so a new month needs no reset: `whatsapp:80:2026-11`. */
export function usageAlertMarker(channel: "whatsapp" | "sms", threshold: UsageThreshold, now: Date): string {
  return `${channel}:${threshold}:${usagePeriod(now).slice(0, 7)}`;
}

/** Thresholds that have been reached and not yet announced this month. 100 implies 80 if both are new. */
export function usageAlertsDue(input: { channel: "whatsapp" | "sms"; used: number; included: number; sent: readonly string[]; now: Date }): UsageThreshold[] {
  if (input.included <= 0) return [];
  const share = usageShare(input.used, input.included);
  const due: UsageThreshold[] = [];
  if (share >= 0.8) due.push(80);
  if (share >= 1) due.push(100);
  return due.filter((threshold) => !input.sent.includes(usageAlertMarker(input.channel, threshold, input.now)));
}

// --- What a plan allows a message to do -------------------------------------------------------------------------

export type MessageChannel = "email" | "whatsapp" | "sms";
export type OverageMode = "stop_marketing" | "bill_overage";

/**
 * Appointment confirmations, reminders, changes and cancellations. These are never silently stopped, whatever the
 * plan says: they fall back to email, and with no usable email they are still sent. Anything else (review requests,
 * waitlist offers, marketing) can be stopped.
 */
const protectedTemplates: ReadonlySet<ChannelTemplateKey> = new Set(["booking_confirmed", "reminder", "rescheduled", "cancelled", "sign_in_code"]);

export function isProtectedMessage(templateKey: string): boolean {
  const key = channelTemplateFor(templateKey);
  return key !== null && protectedTemplates.has(key);
}

export const planChannelLockedCode = "plan_channel_locked";
export const planOverageStoppedCode = "plan_overage_stopped";

export type MessageGate =
  | { action: "send" }
  /** Send by email instead: the plan has no allowance on this channel and the customer has a usable email address. */
  | { action: "fallback_email" }
  /** The plan has no allowance and there is no email to fall back to: send anyway and raise a usage alert. */
  | { action: "send_anyway"; alert: "no_email_fallback" }
  | { action: "block"; code: typeof planChannelLockedCode | typeof planOverageStoppedCode };

export interface MessageGateInput {
  channel: MessageChannel;
  templateKey: string;
  /** The template's cost category when known (`marketing` is the only one that can be stopped past the allowance). */
  costCategory: string | null;
  limits: Pick<PlanLimits, "messagesIncluded">;
  /** Messages sent on this channel this month. */
  used: number;
  overageMode: OverageMode;
  /** True only when the customer has an email address that is not suppressed. */
  hasUsableEmail: boolean;
}

export function decideMessageGate(input: MessageGateInput): MessageGate {
  if (input.channel === "email") return { action: "send" };
  const included = input.limits.messagesIncluded[input.channel];
  const protectedMessage = isProtectedMessage(input.templateKey);
  if (included <= 0) {
    if (!protectedMessage) return { action: "block", code: planChannelLockedCode };
    return input.hasUsableEmail ? { action: "fallback_email" } : { action: "send_anyway", alert: "no_email_fallback" };
  }
  if (input.used >= included && input.costCategory === "marketing" && !protectedMessage && input.overageMode === "stop_marketing") {
    return { action: "block", code: planOverageStoppedCode };
  }
  // Past the allowance with bill_overage, or a utility message past it: still sent, and counted, so the owner sees it.
  return { action: "send" };
}

// --- Upgrade prompts --------------------------------------------------------------------------------------------

export function planName(planKey: PlanKey | null): string {
  return planKey ? planDefinitions[planKey].name : "a higher plan";
}

/** The plain sentence a refusal carries. It names the plan that unlocks the thing. */
export function planLimitMessage(subjectLabel: string, requiredPlan: PlanKey | null, currentPlan: PlanKey): string {
  const current = planDefinitions[currentPlan].name;
  return requiredPlan
    ? `${subjectLabel} isn't included in the ${current} plan. Upgrade to ${planDefinitions[requiredPlan].name} to use it.`
    : `${subjectLabel} is beyond what the ${current} plan allows. Contact us to talk about your needs.`;
}

export function planLimitDetails(subject: string, requiredPlan: PlanKey | null, currentPlan: PlanKey, limit: number | null): PlanLimitDetails {
  return { subject, requiredPlan, currentPlan, limit };
}

export function isPlanKey(value: string): value is PlanKey {
  return (planKeys as readonly string[]).includes(value);
}

/** True when moving from `from` to `to` is an upgrade (a higher plan). */
export function isUpgrade(from: PlanKey, to: PlanKey): boolean {
  return planDefinitions[to].sortOrder > planDefinitions[from].sortOrder;
}
