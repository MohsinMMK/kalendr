/**
 * What every payment provider adapter looks like. Adapters turn a provider's wire format into these
 * shapes and nothing else: they never touch the database, and they hold no card or UPI details.
 * No "server-only": the worker imports this.
 */
import type { PaymentProviderId } from "../../lib/payments";

export interface ProviderCredentials {
  /** Razorpay key id, or the connected Stripe account id. */
  keyId: string;
  /** Razorpay key secret. Stripe uses the platform's key from the environment, so this is empty there. */
  keySecret: string;
  webhookSecret: string;
}

/** A provider call that failed. `retryable` is true for a timeout, a 5xx or a rate limit. */
export class ProviderError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, message = code) {
    super(message);
    this.name = "ProviderError";
  }
}

/** The signature did not match, was missing, or was too old. The route answers 401 and says no more. */
export class WebhookSignatureError extends Error {
  constructor() {
    super("The webhook signature was not valid");
    this.name = "WebhookSignatureError";
  }
}

export type LedgerMethod = "upi" | "card" | "bank" | "other";

/**
 * A webhook after its signature passed, in one shape for every provider. Only ids, amounts and
 * statuses: the payer's email and phone in the raw payload are dropped here and never stored.
 */
export type ProviderEvent =
  | { kind: "payment.captured"; eventId: string; providerOrderId: string; providerPaymentId: string; amountMinor: number; currency: string; method: LedgerMethod }
  | { kind: "payment.failed"; eventId: string; providerOrderId: string | null; providerPaymentId: string | null }
  | { kind: "refund.processed"; eventId: string; providerPaymentId: string; providerRefundId: string; amountMinor: number; currency: string }
  // Subscriptions (feature 25): a renewal charged, a charge that failed, a subscription that ended or paused.
  | { kind: "subscription.renewed"; eventId: string; providerSubscriptionId: string; periodStart: string; periodEnd: string; amountMinor: number; currency: string; method: LedgerMethod }
  | { kind: "subscription.payment_failed"; eventId: string; providerSubscriptionId: string }
  | { kind: "subscription.ended"; eventId: string; providerSubscriptionId: string; reason: "cancelled" | "paused" }
  | { kind: "ignored"; eventId: string; type: string };

export interface CreateOrderInput {
  amountMinor: number;
  currency: string;
  /** Our order id, echoed back so the provider's records can be matched to ours. */
  reference: string;
  businessName: string;
  /** Where a hosted checkout sends the browser afterwards (same origin, a /manage path). */
  returnUrl: string;
  /** Shown to nobody; helps the owner find the booking in the provider's dashboard. */
  description: string;
  expiresAt: Date;
  /** The business's webhook address id. Only the built-in test provider uses it, so its checkout can find the account again. */
  accountPublicId?: string;
}

export interface ProviderOrder {
  providerOrderId: string;
  /** A hosted page to send the browser to. Null when the browser opens the provider's own script (Razorpay). */
  checkoutUrl: string | null;
}

export interface RefundResult {
  providerRefundId: string;
  /** `processed` money is on its way back now; `pending` finishes later and is confirmed by a webhook. */
  status: "processed" | "pending";
}

export interface ProviderPayment {
  providerPaymentId: string;
  amountMinor: number;
  currency: string;
  /** Captured and not fully refunded. */
  captured: boolean;
}

export interface PaymentProvider {
  readonly id: PaymentProviderId;
  /** One harmless call that proves the keys work. Throws ProviderError. */
  verifyAccount(credentials: ProviderCredentials): Promise<void>;
  createOrder(credentials: ProviderCredentials, input: CreateOrderInput): Promise<ProviderOrder>;
  /** `idempotencyKey` makes a retry after a timeout safe: the provider returns the first refund again. */
  refund(credentials: ProviderCredentials, input: { providerPaymentId: string; amountMinor: number; currency: string; idempotencyKey: string }): Promise<RefundResult>;
  /** The payments the provider took in a window, for the nightly check. */
  listPayments(credentials: ProviderCredentials, window: { from: Date; to: Date }): Promise<ProviderPayment[]>;
  /** Checks the signature over the raw body and returns the event. Throws WebhookSignatureError. */
  parseWebhook(credentials: ProviderCredentials, rawBody: string, headers: Headers): ProviderEvent;
}

export const MAX_WEBHOOK_BYTES = 256 * 1024;
