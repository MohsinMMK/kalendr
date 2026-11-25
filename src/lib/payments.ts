/**
 * Online payments (feature 23): the shapes shared by the server and the screens, and the pure rules
 * (what is due now, what the customer is told, what a cancellation refunds). Nothing here talks to a
 * provider or a database, so every rule can be tested on its own.
 *
 * Money is whole numbers in the currency's smallest unit (paise), never floats.
 */
import { z } from "zod";

import { formatMoney, MAX_PAYMENT_MINOR } from "./money";

export const paymentProviders = ["razorpay", "stripe", "fake"] as const;
export type PaymentProviderId = (typeof paymentProviders)[number];
export const paymentModes = ["none", "deposit", "full"] as const;
export type ServicePaymentMode = (typeof paymentModes)[number];
export const accountModes = ["test", "live"] as const;
export type AccountMode = (typeof accountModes)[number];

/** How long an unpaid booking holds its time. */
export const PAYMENT_HOLD_MINUTES = 10;

const amountMinor = z.number().int().positive().max(MAX_PAYMENT_MINOR);

// ---- service pricing --------------------------------------------------------------------------

/** The price and payment mode of one service. `deposit` needs a deposit smaller than the price. */
export const servicePaymentSchema = z.strictObject({
  priceMinor: amountMinor.nullable(),
  paymentMode: z.enum(paymentModes),
  depositMinor: amountMinor.nullable(),
}).superRefine((value, context) => {
  if (value.paymentMode === "none") return;
  if (value.priceMinor === null) context.addIssue({ code: "custom", path: ["priceMinor"], message: "Set a price before asking for payment." });
  if (value.paymentMode === "deposit") {
    if (value.depositMinor === null) context.addIssue({ code: "custom", path: ["depositMinor"], message: "Set the deposit amount." });
    else if (value.priceMinor !== null && value.depositMinor >= value.priceMinor) {
      context.addIssue({ code: "custom", path: ["depositMinor"], message: "The deposit must be less than the price. To take everything now, choose full payment." });
    }
  }
});
export type ServicePaymentInput = z.infer<typeof servicePaymentSchema>;

export interface ServicePayment {
  mode: ServicePaymentMode;
  priceMinor: number | null;
  depositMinor: number | null;
  /** Taken online when the customer books. 0 when no payment is asked for. */
  dueNowMinor: number;
  /** Left for the visit. */
  dueLaterMinor: number;
  currency: string;
}

/** What is paid online and what is left, from the service alone. The browser never supplies an amount. */
export function amountDueNow(input: { mode: ServicePaymentMode; priceMinor: number | null; depositMinor: number | null }): { dueNowMinor: number; dueLaterMinor: number } {
  if (input.mode === "none" || input.priceMinor === null || input.priceMinor <= 0) return { dueNowMinor: 0, dueLaterMinor: input.priceMinor ?? 0 };
  if (input.mode === "full") return { dueNowMinor: input.priceMinor, dueLaterMinor: 0 };
  const deposit = Math.min(input.depositMinor ?? 0, input.priceMinor);
  return { dueNowMinor: deposit, dueLaterMinor: input.priceMinor - deposit };
}

/** "Customers pay ₹200 now and ₹600 at the visit." */
export function livePaymentExample(payment: ServicePayment, visitWord = "visit"): string | null {
  if (payment.dueNowMinor <= 0) return null;
  const now = formatMoney(payment.dueNowMinor, payment.currency);
  if (payment.dueLaterMinor <= 0) return `Customers pay ${now} when they book.`;
  return `Customers pay ${now} now and ${formatMoney(payment.dueLaterMinor, payment.currency)} at the ${visitWord}.`;
}

// ---- the policy -------------------------------------------------------------------------------

export const afterWindowRules = ["no_refund", "keep_deposit"] as const;
export const noShowRules = ["deposit", "everything"] as const;

export const paymentPolicySchema = z.strictObject({
  freeCancelHours: z.number().int().min(0).max(8760),
  afterWindowRule: z.enum(afterWindowRules),
  noShowRule: z.enum(noShowRules),
  /** The version the screen was showing, so two people saving at once do not overwrite each other. */
  version: z.number().int().positive().optional(),
});
export type PaymentPolicyInput = z.infer<typeof paymentPolicySchema>;

export interface PaymentPolicy {
  freeCancelHours: number;
  afterWindowRule: (typeof afterWindowRules)[number];
  noShowRule: (typeof noShowRules)[number];
  version: number;
}

export const defaultPaymentPolicy: PaymentPolicy = { freeCancelHours: 24, afterWindowRule: "no_refund", noShowRule: "deposit", version: 1 };

function hoursPhrase(hours: number): string {
  if (hours === 0) return "any time before it starts";
  if (hours % 24 === 0) {
    const days = hours / 24;
    return `at least ${days} ${days === 1 ? "day" : "days"} before it starts`;
  }
  return `at least ${hours} ${hours === 1 ? "hour" : "hours"} before it starts`;
}

/**
 * The exact words the customer sees before paying. They are stored on the appointment as they were
 * shown, so a later change of policy never rewrites what someone agreed to.
 */
export function policyWording(policy: Pick<PaymentPolicy, "freeCancelHours" | "afterWindowRule" | "noShowRule">, payment: Pick<ServicePayment, "mode" | "depositMinor" | "dueNowMinor" | "currency">, visitWord = "visit"): string {
  if (payment.dueNowMinor <= 0) return "";
  const kind = payment.mode === "deposit" ? "deposit" : "payment";
  const lines = [`You pay ${formatMoney(payment.dueNowMinor, payment.currency)} now as a ${kind}.`];
  lines.push(`Cancel or move your ${visitWord} ${hoursPhrase(policy.freeCancelHours)} for a full refund of what you paid.`);
  if (policy.afterWindowRule === "no_refund") lines.push("After that, there is no refund.");
  else if (payment.mode === "deposit") lines.push(`After that, your ${formatMoney(payment.depositMinor ?? payment.dueNowMinor, payment.currency)} deposit is kept and anything you paid beyond it is refunded.`);
  else lines.push("After that, there is no refund.");
  lines.push(policy.noShowRule === "everything" ? `If you do not come, everything you paid is kept.` : `If you do not come, your ${kind} is kept.`);
  return lines.join(" ");
}

export type PolicyEvent = "cancel" | "no_show";

export interface RefundDecision {
  action: "refund" | "keep";
  /** Handed back through the provider. */
  refundMinor: number;
  /** Kept by the business. */
  keptMinor: number;
}

/**
 * What a cancellation or no-show does with the money paid online. Worked out from the rules stored on
 * the appointment, never the live policy. `depositMinor` is what was agreed as the deposit (null for a full payment).
 */
export function decideRefund(input: {
  event: PolicyEvent;
  policy: Pick<PaymentPolicy, "freeCancelHours" | "afterWindowRule" | "noShowRule">;
  startsAt: Date;
  now: Date;
  paidOnlineMinor: number;
  depositMinor: number | null;
}): RefundDecision {
  const paid = Math.max(0, input.paidOnlineMinor);
  if (paid === 0) return { action: "keep", refundMinor: 0, keptMinor: 0 };
  const depositKept = Math.min(paid, input.depositMinor ?? paid);
  if (input.event === "no_show") {
    const kept = input.policy.noShowRule === "everything" ? paid : depositKept;
    return { action: "keep", refundMinor: paid - kept, keptMinor: kept };
  }
  const hoursBefore = (input.startsAt.getTime() - input.now.getTime()) / 3_600_000;
  if (hoursBefore >= input.policy.freeCancelHours) return { action: "refund", refundMinor: paid, keptMinor: 0 };
  if (input.policy.afterWindowRule === "keep_deposit") return { action: depositKept < paid ? "refund" : "keep", refundMinor: paid - depositKept, keptMinor: depositKept };
  return { action: "keep", refundMinor: 0, keptMinor: paid };
}

/** What gets stored on the appointment when it is booked. */
export interface PaymentTermsSnapshot {
  mode: ServicePaymentMode;
  priceMinor: number;
  depositMinor: number | null;
  dueNowMinor: number;
  currency: string;
  freeCancelHours: number;
  afterWindowRule: PaymentPolicy["afterWindowRule"];
  noShowRule: PaymentPolicy["noShowRule"];
  agreedAt: string;
}

// ---- public (customer) contracts --------------------------------------------------------------

/** Added to a service in the public catalog when it takes payment online. Null when it does not. */
export interface PublicServicePayment {
  mode: Exclude<ServicePaymentMode, "none">;
  priceMinor: number;
  depositMinor: number | null;
  dueNowMinor: number;
  dueLaterMinor: number;
  currency: string;
  /** The words shown before paying (`policyWording`). */
  policyText: string;
}

/** Returned with a new booking that must be paid for before it is confirmed. */
export interface BookingPaymentRequired {
  dueNowMinor: number;
  currency: string;
  /** When the held time is let go if nothing is paid. */
  expiresAt: string;
  policyText: string;
}

/** POST /api/public/bookings/pay: ask for the checkout of a booking that is waiting for payment. */
export const startPaymentSchema = z.strictObject({
  clinicSlug: z.string().trim().min(1).max(120),
  manageToken: z.string().trim().min(20).max(200),
});
export type StartPaymentInput = z.infer<typeof startPaymentSchema>;

/** What the browser needs to open the provider's checkout. Never a secret. */
export interface CheckoutSession {
  provider: PaymentProviderId;
  orderId: string;
  amountMinor: number;
  currency: string;
  /** Razorpay's public key id for Checkout.js. */
  keyId: string | null;
  /** The provider's hosted page (Stripe, and the built-in test checkout). */
  checkoutUrl: string | null;
  expiresAt: string;
  mode: AccountMode;
  businessName: string;
}

/**
 * POST /api/public/bookings/pay/status: the "confirming…" screen polls this. Only the webhook ever makes it `confirmed`.
 * @alias
 */
export const paymentStatusSchema = startPaymentSchema;
export interface PaymentStatus {
  state: "waiting" | "confirmed" | "expired" | "cancelled";
  appointmentStatus: string;
  expiresAt: string | null;
}

// ---- staff contracts --------------------------------------------------------------------------

const razorpayKeyId = z.string().trim().regex(/^rzp_(test|live)_[A-Za-z0-9]{6,40}$/, "That does not look like a Razorpay key id. It starts with rzp_test_ or rzp_live_.");

/** PUT /api/staff/payment-account. Needs a recent second-factor check. */
export const paymentAccountInputSchema = z.discriminatedUnion("provider", [
  z.strictObject({
    provider: z.literal("razorpay"),
    keyId: razorpayKeyId,
    keySecret: z.string().trim().min(8).max(120),
    webhookSecret: z.string().trim().min(8).max(120),
  }),
  z.strictObject({ provider: z.literal("fake") }),
]);
export type PaymentAccountInput = z.infer<typeof paymentAccountInputSchema>;

export interface PaymentAccountView {
  provider: PaymentProviderId;
  mode: AccountMode;
  status: "active" | "disabled";
  /** Enough to recognise the account: the key id, or the connected Stripe account. Never a secret. */
  keyId: string;
  /** The address to paste into the provider's dashboard as the webhook endpoint. */
  webhookUrl: string;
  lastCheckedAt: string | null;
}

export interface PaymentSettingsView {
  account: PaymentAccountView | null;
  policy: PaymentPolicy;
  /** Which ways of connecting are on offer here (the built-in test account is not offered in production). */
  providers: { razorpay: boolean; stripe: boolean; fake: boolean };
}

export interface MismatchView {
  id: string;
  day: string;
  kind: "missing_here" | "missing_at_provider" | "amount_differs";
  providerPaymentId: string;
  providerAmountMinor: number | null;
  ledgerAmountMinor: number | null;
  resolved: boolean;
}

export const resolveMismatchSchema = z.strictObject({ note: z.string().trim().max(200).optional() });

/** POST /api/staff/appointments/[id]/payment-link: a pay link for a booking that still owes money. */
export const paymentLinkInputSchema = z.strictObject({
  /** Also message it to the customer ("Pay ₹500 to confirm your visit"). */
  send: z.boolean().default(false),
});
export interface PaymentLinkResult {
  url: string;
  amountMinor: number;
  currency: string;
  expiresAt: string;
  sent: boolean;
}

export function isTestMode(mode: AccountMode): boolean {
  return mode === "test";
}
