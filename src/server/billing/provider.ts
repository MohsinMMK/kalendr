import type { BillingProvider, CheckoutResult } from "../../lib/billing-contracts";
import type { PlanKey } from "../../lib/entitlements";

/**
 * What subscription billing needs from a payment provider (Razorpay in India, Stripe elsewhere). The adapters in
 * razorpay.ts and stripe.ts are thin wrappers over the SDKs; tests inject `FakeSubscriptionProvider` and never call
 * a real one. Nothing here sees a card or UPI detail: the provider's own page or sheet collects those.
 */

export interface CheckoutRequest {
  tenantId: string;
  planKey: PlanKey;
  /** The provider's id for this plan: a Razorpay plan id or a Stripe price id. */
  providerPlanId: string;
  /** Stripe prefills its checkout with this and sends receipts to it. Razorpay is not told. */
  ownerEmail: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutOutcome {
  result: CheckoutResult;
  /** Known at once for Razorpay (the subscription is made first); Stripe learns it from its webhook. */
  providerSubscriptionId: string | null;
  providerCustomerId: string | null;
}

export interface PlanChangeRequest {
  providerSubscriptionId: string;
  providerPlanId: string;
  /** "now": charge the pro-rated difference at once. "cycle_end": switch the price from the next renewal, no charge now. */
  when: "now" | "cycle_end";
  tenantId: string;
  planKey: PlanKey;
}

export interface SubscriptionProvider {
  readonly name: BillingProvider;
  createCheckout(request: CheckoutRequest): Promise<CheckoutOutcome>;
  changePlan(request: PlanChangeRequest): Promise<void>;
  /** Stop renewing at the end of the paid period. */
  cancelAtPeriodEnd(providerSubscriptionId: string): Promise<void>;
  /** End it now (a downgrade to Free once the period is over). */
  cancelNow(providerSubscriptionId: string): Promise<void>;
  /** Undo a cancellation that has not happened yet. */
  resume(providerSubscriptionId: string): Promise<void>;
}

export class ProviderNotConfiguredError extends Error {
  constructor(readonly provider: BillingProvider) {
    super(`${provider} keys are not set`);
    this.name = "ProviderNotConfiguredError";
  }
}

type Factory = (name: BillingProvider) => SubscriptionProvider | null;
let override: Factory | null = null;

/** Tests swap the providers for fakes. Passing null restores the real ones. */
export function setSubscriptionProviderFactory(factory: Factory | null): void {
  override = factory;
}

export function overriddenProvider(name: BillingProvider): SubscriptionProvider | null | undefined {
  return override ? override(name) : undefined;
}

/** A recording provider for tests. Every call is appended to `calls`. */
export class FakeSubscriptionProvider implements SubscriptionProvider {
  readonly calls: { method: string; args: unknown }[] = [];
  constructor(readonly name: BillingProvider) {}
  async createCheckout(request: CheckoutRequest): Promise<CheckoutOutcome> {
    this.calls.push({ method: "createCheckout", args: request });
    return this.name === "razorpay"
      ? { result: { kind: "razorpay", keyId: "rzp_test_fake", subscriptionId: `sub_fake_${request.tenantId.slice(0, 8)}` }, providerSubscriptionId: `sub_fake_${request.tenantId.slice(0, 8)}`, providerCustomerId: null }
      : { result: { kind: "redirect", url: "https://checkout.example.test/session" }, providerSubscriptionId: null, providerCustomerId: null };
  }
  async changePlan(request: PlanChangeRequest): Promise<void> { this.calls.push({ method: "changePlan", args: request }); }
  async cancelAtPeriodEnd(id: string): Promise<void> { this.calls.push({ method: "cancelAtPeriodEnd", args: id }); }
  async cancelNow(id: string): Promise<void> { this.calls.push({ method: "cancelNow", args: id }); }
  async resume(id: string): Promise<void> { this.calls.push({ method: "resume", args: id }); }
}
