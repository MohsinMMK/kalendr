/**
 * Pure rules for packages, memberships and coupons (feature 25). No database: the server reads the facts, calls these and
 * writes the result, so every rule here is tested on its own.
 */

import { pastDueGraceDays } from "./entitlements";

export const couponKinds = ["percent", "fixed"] as const;
export type CouponKind = (typeof couponKinds)[number];

const codePattern = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

/** What is stored and compared: capitals, no spaces. Customers type it any way they like. */
export function normaliseCode(input: string): string {
  return input.replace(/\s+/g, "").toUpperCase();
}

export function isValidCode(code: string): boolean {
  return codePattern.test(code);
}

export interface CouponTerms {
  kind: CouponKind;
  /** Percent (1 to 100) or an amount in the smallest unit. */
  value: number;
  stackable: boolean;
}

export interface PriceBreakdown {
  listMinor: number;
  netMinor: number;
  /** In the order taken: member price, then coupon. Tax comes after both, on the invoice. */
  discounts: { kind: "member_price" | "coupon"; amountMinor: number }[];
  /** A coupon was given but cannot sit on top of a member price. The caller refuses it with a plain message. */
  couponRefused: "not_stackable" | null;
}

function percentOf(amountMinor: number, percent: number): number {
  return Math.floor((amountMinor * percent * 2 + 100) / 200);
}

/**
 * The price of a booking. The order is fixed: member price first, then the coupon on what is left, then tax (taken on
 * the invoice from this net price). One discount per booking unless the coupon is marked stackable.
 */
export function priceBooking(input: { listMinor: number; memberPercent?: number; coupon?: CouponTerms | null }): PriceBreakdown {
  const discounts: PriceBreakdown["discounts"] = [];
  let net = input.listMinor;
  const memberPercent = input.memberPercent ?? 0;
  if (memberPercent > 0 && net > 0) {
    const amount = Math.min(net, percentOf(net, memberPercent));
    if (amount > 0) {
      discounts.push({ kind: "member_price", amountMinor: amount });
      net -= amount;
    }
  }
  let couponRefused: PriceBreakdown["couponRefused"] = null;
  if (input.coupon && net > 0) {
    if (discounts.length > 0 && !input.coupon.stackable) {
      couponRefused = "not_stackable";
    } else {
      const amount = input.coupon.kind === "percent" ? percentOf(net, input.coupon.value) : Math.min(net, input.coupon.value);
      const capped = Math.min(net, amount);
      if (capped > 0) {
        discounts.push({ kind: "coupon", amountMinor: capped });
        net -= capped;
      }
    }
  }
  return { listMinor: input.listMinor, netMinor: net, discounts, couponRefused };
}

export type CouponRefusal =
  | "inactive" | "not_started" | "expired" | "wrong_service" | "not_first_visit" | "customer_limit" | "used_up";

export interface CouponFacts {
  isActive: boolean;
  validFrom: Date | null;
  validTo: Date | null;
  serviceIds: readonly string[];
  firstVisitOnly: boolean;
  maxUses: number | null;
  perCustomerLimit: number | null;
}

export interface CouponUseContext {
  now: Date;
  serviceId: string;
  /** The customer has had a visit here before (not counting this one). */
  hasPriorVisit: boolean;
  /** Redemptions of this code by this customer that still count. */
  customerUses: number;
  /** Redemptions of this code by everyone that still count. */
  totalUses: number;
}

/** Why a code cannot be used right now, or null when it can. The staff screen shows the reason; customers are never told which. */
export function couponRefusal(coupon: CouponFacts, use: CouponUseContext): CouponRefusal | null {
  if (!coupon.isActive) return "inactive";
  if (coupon.validFrom && use.now < coupon.validFrom) return "not_started";
  if (coupon.validTo && use.now >= coupon.validTo) return "expired";
  if (coupon.serviceIds.length > 0 && !coupon.serviceIds.includes(use.serviceId)) return "wrong_service";
  if (coupon.firstVisitOnly && use.hasPriorVisit) return "not_first_visit";
  if (coupon.perCustomerLimit !== null && use.customerUses >= coupon.perCustomerLimit) return "customer_limit";
  if (coupon.maxUses !== null && use.totalUses >= coupon.maxUses) return "used_up";
  return null;
}

export const couponRefusalText: Record<CouponRefusal, string> = {
  inactive: "This code has been switched off.",
  not_started: "This code isn't valid yet.",
  expired: "This code has expired.",
  wrong_service: "This code doesn't apply to that service.",
  not_first_visit: "This code is for first visits only.",
  customer_limit: "This customer has already used this code as many times as it allows.",
  used_up: "This code has been used as many times as it allows.",
};

/** What every customer is told when a code fails, whatever the reason, so codes cannot be guessed from the answers. */
export const GENERIC_COUPON_REFUSAL = "That code isn't valid for this booking.";

export function describeCoupon(kind: CouponKind, value: number, formatMoney: (minor: number) => string): string {
  return kind === "percent" ? `${value}% off` : `${formatMoney(value)} off`;
}

// --- Memberships -----------------------------------------------------------------------------------------------

export type MembershipStatus = "active" | "past_due" | "paused" | "cancelled";

const DAY = 86_400_000;

/** Whether benefits (credits, member price) are on. A failed renewal keeps them for 7 days, then they pause. */
export function membershipBenefitsOn(status: MembershipStatus, pastDueSince: Date | null, now: Date): boolean {
  if (status === "active") return true;
  if (status === "past_due") return pastDueSince !== null && now.getTime() - pastDueSince.getTime() < pastDueGraceDays * DAY;
  return false;
}

/** Day that grace ends, for the screen and the message to the customer. */
export function graceEndsAt(pastDueSince: Date): Date {
  return new Date(pastDueSince.getTime() + pastDueGraceDays * DAY);
}

// --- Expiry reminders --------------------------------------------------------------------------------------------

export type ReminderStage = 14 | 3;

/** Which reminder is due for a package that still has credits: the 3-day one wins when both are due. */
export function reminderDue(input: { expiresAt: Date; now: Date; remaining: number; sent14: boolean; sent3: boolean }): ReminderStage | null {
  if (input.remaining <= 0 || input.expiresAt <= input.now) return null;
  const daysLeft = (input.expiresAt.getTime() - input.now.getTime()) / DAY;
  if (daysLeft <= 3 && !input.sent3) return 3;
  if (daysLeft <= 14 && daysLeft > 3 && !input.sent14) return 14;
  return null;
}

export function expiryReminderText(input: { name: string; remaining: number; validUntil: Date; timeZone: string; businessName: string }): string {
  const until = new Intl.DateTimeFormat("en-IN", { timeZone: input.timeZone, day: "numeric", month: "long" }).format(input.validUntil);
  const sessions = input.remaining === 1 ? "1 session" : `${input.remaining} sessions`;
  return `${input.businessName}: You have ${sessions} left on ${input.name}, valid until ${until}.`;
}
