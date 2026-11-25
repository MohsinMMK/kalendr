/**
 * Razorpay (India): Orders, Checkout.js in the browser, refunds, and signed webhooks.
 * Written against Razorpay's REST API with fetch, parsed through zod, so nothing here needs the SDK.
 * The webhook signature is HMAC-SHA256 of the raw body in `X-Razorpay-Signature`; events are told apart by `x-razorpay-event-id`.
 * No "server-only": the worker imports this.
 */
import { z } from "zod";

import { callProvider, type Fetcher } from "./http";
import { hmacHex, sameSignature } from "./signature";
import {
  WebhookSignatureError,
  type CreateOrderInput, type LedgerMethod, type PaymentProvider, type ProviderCredentials, type ProviderEvent, type ProviderPayment,
} from "./types";

const API = "https://api.razorpay.com/v1";

function auth(credentials: ProviderCredentials): HeadersInit {
  return {
    Authorization: `Basic ${Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString("base64")}`,
    "Content-Type": "application/json",
  };
}

const orderSchema = z.object({ id: z.string().min(1).max(80) });
const refundSchema = z.object({ id: z.string().min(1).max(80), status: z.string() });
const listSchema = z.object({
  items: z.array(z.object({ id: z.string(), amount: z.number().int(), currency: z.string(), status: z.string() })),
});
const probeSchema = z.object({ entity: z.string().optional() }).passthrough();

const paymentEntity = z.object({
  id: z.string().min(1).max(80),
  order_id: z.string().min(1).max(80).nullish(),
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  method: z.string().optional(),
});
const refundEntity = z.object({
  id: z.string().min(1).max(80),
  payment_id: z.string().min(1).max(80),
  amount: z.number().int().positive(),
  currency: z.string().length(3),
});
const subscriptionEntity = z.object({
  id: z.string().min(1).max(120),
  current_start: z.number().int().nullish(),
  current_end: z.number().int().nullish(),
});
const webhookSchema = z.object({
  event: z.string().max(80),
  payload: z.object({
    subscription: z.object({ entity: z.unknown() }).optional(),
    payment: z.object({ entity: z.unknown() }).optional(),
    refund: z.object({ entity: z.unknown() }).optional(),
  }).passthrough(),
}).passthrough();

export function razorpayMethod(method: string | undefined): LedgerMethod {
  if (method === "upi") return "upi";
  if (method === "card") return "card";
  if (method === "netbanking") return "bank";
  return "other";
}

export function createRazorpay(fetcher: Fetcher = fetch): PaymentProvider {
  return {
    id: "razorpay",
    async verifyAccount(credentials) {
      await callProvider(fetcher, `${API}/orders?count=1`, { method: "GET", headers: auth(credentials) }, probeSchema);
    },
    async createOrder(credentials, input: CreateOrderInput) {
      const order = await callProvider(fetcher, `${API}/orders`, {
        method: "POST",
        headers: auth(credentials),
        // `notes` helps the owner find the booking in Razorpay's dashboard. It carries no customer details.
        body: JSON.stringify({ amount: input.amountMinor, currency: input.currency, receipt: input.reference, notes: { kalendr_order: input.reference } }),
      }, orderSchema);
      return { providerOrderId: order.id, checkoutUrl: null };
    },
    async refund(credentials, input) {
      const refund = await callProvider(fetcher, `${API}/payments/${encodeURIComponent(input.providerPaymentId)}/refund`, {
        method: "POST",
        headers: { ...auth(credentials), "X-Refund-Idempotency": input.idempotencyKey },
        body: JSON.stringify({ amount: input.amountMinor, speed: "normal", receipt: input.idempotencyKey.slice(0, 40) }),
      }, refundSchema);
      return { providerRefundId: refund.id, status: refund.status === "processed" ? "processed" : "pending" };
    },
    async listPayments(credentials, window) {
      const found: ProviderPayment[] = [];
      for (let skip = 0; skip < 1000; skip += 100) {
        const query = new URLSearchParams({ from: String(Math.floor(window.from.getTime() / 1000)), to: String(Math.floor(window.to.getTime() / 1000)), count: "100", skip: String(skip) });
        const page = await callProvider(fetcher, `${API}/payments?${query}`, { method: "GET", headers: auth(credentials) }, listSchema);
        found.push(...page.items.map((item): ProviderPayment => ({
          providerPaymentId: item.id, amountMinor: item.amount, currency: item.currency, captured: item.status === "captured",
        })));
        if (page.items.length < 100) break;
      }
      return found;
    },
    parseWebhook(credentials, rawBody, headers): ProviderEvent {
      const signature = headers.get("x-razorpay-signature");
      if (!signature || !sameSignature(hmacHex(credentials.webhookSecret, rawBody), signature)) throw new WebhookSignatureError();
      const eventId = headers.get("x-razorpay-event-id");
      if (!eventId || eventId.length > 120) throw new WebhookSignatureError();
      let json: unknown;
      try { json = JSON.parse(rawBody); } catch { return { kind: "ignored", eventId, type: "unparsable" }; }
      const body = webhookSchema.safeParse(json);
      if (!body.success) return { kind: "ignored", eventId, type: "unrecognised" };
      const { event, payload } = body.data;
      if (event === "payment.captured") {
        const payment = paymentEntity.safeParse(payload.payment?.entity);
        if (!payment.success || !payment.data.order_id) return { kind: "ignored", eventId, type: event };
        return { kind: "payment.captured", eventId, providerOrderId: payment.data.order_id, providerPaymentId: payment.data.id, amountMinor: payment.data.amount, currency: payment.data.currency, method: razorpayMethod(payment.data.method) };
      }
      if (event === "payment.failed") {
        const payment = paymentEntity.partial().safeParse(payload.payment?.entity);
        return { kind: "payment.failed", eventId, providerOrderId: payment.success ? payment.data.order_id ?? null : null, providerPaymentId: payment.success ? payment.data.id ?? null : null };
      }
      if (event === "refund.processed") {
        const refund = refundEntity.safeParse(payload.refund?.entity);
        if (!refund.success) return { kind: "ignored", eventId, type: event };
        return { kind: "refund.processed", eventId, providerPaymentId: refund.data.payment_id, providerRefundId: refund.data.id, amountMinor: refund.data.amount, currency: refund.data.currency };
      }
      // Subscriptions (feature 25). Written from Razorpay's documented events; not yet exercised against a live account.
      if (event === "subscription.charged") {
        const subscription = subscriptionEntity.safeParse(payload.subscription?.entity);
        const payment = paymentEntity.safeParse(payload.payment?.entity);
        if (!subscription.success || !payment.success || !subscription.data.current_start || !subscription.data.current_end) return { kind: "ignored", eventId, type: event };
        return {
          kind: "subscription.renewed", eventId, providerSubscriptionId: subscription.data.id, periodStart: new Date(subscription.data.current_start * 1000).toISOString(),
          periodEnd: new Date(subscription.data.current_end * 1000).toISOString(), amountMinor: payment.data.amount, currency: payment.data.currency, method: razorpayMethod(payment.data.method),
        };
      }
      if (event === "subscription.pending" || event === "subscription.halted") {
        const subscription = subscriptionEntity.safeParse(payload.subscription?.entity);
        return subscription.success ? { kind: "subscription.payment_failed", eventId, providerSubscriptionId: subscription.data.id } : { kind: "ignored", eventId, type: event };
      }
      if (event === "subscription.cancelled" || event === "subscription.completed" || event === "subscription.paused") {
        const subscription = subscriptionEntity.safeParse(payload.subscription?.entity);
        return subscription.success
          ? { kind: "subscription.ended", eventId, providerSubscriptionId: subscription.data.id, reason: event === "subscription.paused" ? "paused" : "cancelled" }
          : { kind: "ignored", eventId, type: event };
      }
      return { kind: "ignored", eventId, type: event.slice(0, 80) };
    },
  };
}
