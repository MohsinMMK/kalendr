/**
 * Which adapter serves which provider id. Stripe needs the platform key from the environment, so it is
 * only offered when that is set. No "server-only": the worker imports this.
 */
import type { PaymentProviderId } from "../../lib/payments";
import { createFake } from "./fake";
import type { Fetcher } from "./http";
import { createRazorpay } from "./razorpay";
import { createStripe } from "./stripe";
import { ProviderError, type PaymentProvider } from "./types";

export interface ProviderEnvironment {
  stripeSecretKey?: string | undefined;
  fetcher?: Fetcher | undefined;
}

export function providerFor(id: PaymentProviderId, environment: ProviderEnvironment = {}): PaymentProvider {
  if (id === "razorpay") return createRazorpay(environment.fetcher);
  if (id === "fake") return createFake();
  if (!environment.stripeSecretKey) throw new ProviderError("stripe_not_configured", false, "Stripe is not set up on this server.");
  return createStripe({ secretKey: environment.stripeSecretKey }, environment.fetcher);
}
