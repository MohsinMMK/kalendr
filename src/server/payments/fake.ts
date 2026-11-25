/**
 * The built-in test provider: it takes no money and calls nobody. It exists so a business can try the
 * whole flow, and so browser tests can run it end to end. Its "checkout" is the app's own /pay/test page,
 * which posts a body signed with the account's webhook secret to the real webhook route, exactly as Razorpay would.
 * Never available in production (see `fakeProviderAllowed`). No "server-only": the worker imports this.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { testCheckoutEnabled } from "../../lib/test-checkout";
import { hmacHex, sameSignature } from "./signature";
import {
  WebhookSignatureError,
  type PaymentProvider, type ProviderEvent,
} from "./types";

export const FAKE_SIGNATURE_HEADER = "x-fake-signature";

/** Never in production, except for browser tests that run the production build on this machine (see src/lib/test-checkout.ts). */
export function fakeProviderAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return testCheckoutEnabled(env);
}

const bodySchema = z.object({
  id: z.string().min(1).max(120),
  type: z.enum(["payment.captured", "payment.failed", "refund.processed", "subscription.renewed", "subscription.payment_failed", "subscription.ended"]),
  subscriptionId: z.string().max(120).nullish(),
  periodStart: z.iso.datetime({ offset: true }).nullish(),
  periodEnd: z.iso.datetime({ offset: true }).nullish(),
  reason: z.enum(["cancelled", "paused"]).nullish(),
  orderId: z.string().max(80).nullish(),
  paymentId: z.string().max(80).nullish(),
  refundId: z.string().max(80).nullish(),
  amountMinor: z.number().int().positive().nullish(),
  currency: z.string().length(3).nullish(),
});
export type FakeWebhookBody = z.infer<typeof bodySchema>;

export function signFakeWebhook(secret: string, body: FakeWebhookBody): { rawBody: string; signature: string } {
  const rawBody = JSON.stringify(body);
  return { rawBody, signature: hmacHex(secret, rawBody) };
}

export function createFake(): PaymentProvider {
  return {
    id: "fake",
    async verifyAccount() {},
    async createOrder(_credentials, input) {
      // The account's address id (hex, so the order id has no dots and is never mistaken for a file by the proxy) travels in the order id so the test checkout can find the account again.
      return { providerOrderId: `fake_${input.accountPublicId ?? "unknown"}_${randomBytes(9).toString("hex")}`, checkoutUrl: null };
    },

    
    async refund(_credentials, input) {
      // A repeat of the same refund key returns the same refund, like a real provider.
      return { providerRefundId: `fake_refund_${hmacHex("fake-refund", input.idempotencyKey).slice(0, 18)}`, status: "processed" };
    },
    async listPayments() {
      return [];
    },
    parseWebhook(credentials, rawBody, headers): ProviderEvent {
      const signature = headers.get(FAKE_SIGNATURE_HEADER);
      if (!signature || !sameSignature(hmacHex(credentials.webhookSecret, rawBody), signature)) throw new WebhookSignatureError();
      let json: unknown;
      try { json = JSON.parse(rawBody); } catch { throw new WebhookSignatureError(); }
      const body = bodySchema.safeParse(json);
      if (!body.success) throw new WebhookSignatureError();
      const { id, type, orderId, paymentId, refundId, amountMinor, currency, subscriptionId, periodStart, periodEnd, reason } = body.data;
      if (type === "subscription.renewed" && subscriptionId && periodStart && periodEnd && amountMinor && currency) {
        return { kind: "subscription.renewed", eventId: id, providerSubscriptionId: subscriptionId, periodStart, periodEnd, amountMinor, currency, method: "card" };
      }
      if (type === "subscription.payment_failed" && subscriptionId) return { kind: "subscription.payment_failed", eventId: id, providerSubscriptionId: subscriptionId };
      if (type === "subscription.ended" && subscriptionId && reason) return { kind: "subscription.ended", eventId: id, providerSubscriptionId: subscriptionId, reason };
      if (type === "payment.captured" && orderId && paymentId && amountMinor && currency) {
        return { kind: "payment.captured", eventId: id, providerOrderId: orderId, providerPaymentId: paymentId, amountMinor, currency, method: "upi" };
      }
      if (type === "payment.failed") return { kind: "payment.failed", eventId: id, providerOrderId: orderId ?? null, providerPaymentId: paymentId ?? null };
      if (type === "refund.processed" && paymentId && refundId && amountMinor && currency) {
        return { kind: "refund.processed", eventId: id, providerPaymentId: paymentId, providerRefundId: refundId, amountMinor, currency };
      }
      return { kind: "ignored", eventId: id, type };
    },
  };
}
