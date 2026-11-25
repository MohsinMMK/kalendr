import Razorpay from "razorpay";

import { ProviderNotConfiguredError, type CheckoutOutcome, type CheckoutRequest, type PlanChangeRequest, type SubscriptionProvider } from "./provider";

export interface RazorpayKeys { keyId: string; keySecret: string }

/** Razorpay Subscriptions (UPI Autopay or card). The customer authorises the mandate in Razorpay's own sheet. */
export function createRazorpayProvider(keys: RazorpayKeys | null): SubscriptionProvider {
  const client = (): Razorpay => {
    if (!keys) throw new ProviderNotConfiguredError("razorpay");
    return new Razorpay({ key_id: keys.keyId, key_secret: keys.keySecret });
  };
  return {
    name: "razorpay",
    async createCheckout(request: CheckoutRequest): Promise<CheckoutOutcome> {
      if (!keys) throw new ProviderNotConfiguredError("razorpay");
      // total_count is how many cycles Razorpay will charge before stopping; 120 monthly cycles is ten years.
      const subscription = await client().subscriptions.create({
        plan_id: request.providerPlanId,
        total_count: 120,
        customer_notify: true,
        // The tenant id rides in notes so every webhook can name the business without a lookup.
        notes: { tenantId: request.tenantId, planKey: request.planKey },
      });
      return {
        result: { kind: "razorpay", keyId: keys.keyId, subscriptionId: subscription.id },
        providerSubscriptionId: subscription.id,
        providerCustomerId: null,
      };
    },
    async changePlan(request: PlanChangeRequest): Promise<void> {
      await client().subscriptions.update(request.providerSubscriptionId, {
        plan_id: request.providerPlanId,
        schedule_change_at: request.when === "now" ? "now" : "cycle_end",
      });
    },
    async cancelAtPeriodEnd(id: string): Promise<void> { await client().subscriptions.cancel(id, true); },
    async cancelNow(id: string): Promise<void> { await client().subscriptions.cancel(id, false); },
    async resume(id: string): Promise<void> { await client().subscriptions.cancelScheduledChanges(id); },
  };
}
