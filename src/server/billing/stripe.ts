import Stripe from "stripe";

import { ProviderNotConfiguredError, type CheckoutOutcome, type CheckoutRequest, type PlanChangeRequest, type SubscriptionProvider } from "./provider";

/** Stripe Checkout in subscription mode, then subscription updates for plan changes and cancellation. */
export function createStripeProvider(secretKey: string | null): SubscriptionProvider {
  const client = (): Stripe => {
    if (!secretKey) throw new ProviderNotConfiguredError("stripe");
    return new Stripe(secretKey, { maxNetworkRetries: 1, timeout: 10_000 });
  };
  const firstItem = async (stripe: Stripe, id: string): Promise<string> => {
    const subscription = await stripe.subscriptions.retrieve(id);
    const item = subscription.items.data[0];
    if (!item) throw new Error("Stripe subscription has no items");
    return item.id;
  };
  return {
    name: "stripe",
    async createCheckout(request: CheckoutRequest): Promise<CheckoutOutcome> {
      const stripe = client();
      const metadata = { tenantId: request.tenantId, planKey: request.planKey };
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: request.providerPlanId, quantity: 1 }],
        success_url: request.successUrl,
        cancel_url: request.cancelUrl,
        customer_email: request.ownerEmail,
        client_reference_id: request.tenantId,
        metadata,
        subscription_data: { metadata },
      });
      if (!session.url) throw new Error("Stripe returned no checkout address");
      return { result: { kind: "redirect", url: session.url }, providerSubscriptionId: null, providerCustomerId: null };
    },
    async changePlan(request: PlanChangeRequest): Promise<void> {
      const stripe = client();
      const itemId = await firstItem(stripe, request.providerSubscriptionId);
      await stripe.subscriptions.update(request.providerSubscriptionId, {
        items: [{ id: itemId, price: request.providerPlanId }],
        // Upgrades invoice the pro-rated difference now; a downgrade only changes the price of the next renewal.
        proration_behavior: request.when === "now" ? "always_invoice" : "none",
        metadata: { tenantId: request.tenantId, planKey: request.planKey },
      });
    },
    async cancelAtPeriodEnd(id: string): Promise<void> { await client().subscriptions.update(id, { cancel_at_period_end: true }); },
    async cancelNow(id: string): Promise<void> { await client().subscriptions.cancel(id); },
    async resume(id: string): Promise<void> { await client().subscriptions.update(id, { cancel_at_period_end: false }); },
  };
}
