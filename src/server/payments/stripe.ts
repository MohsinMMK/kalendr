/**
 * Stripe Connect (outside India). The business connects its own Stripe account (OAuth); Kalendr calls
 * the API with the platform key and the `Stripe-Account` header, so money settles with the business.
 * Checkout Sessions are the hosted page. One platform webhook receives every connected account's events,
 * told apart by `event.account`. The signature is `t=<time>,v1=<HMAC-SHA256 of "<time>.<raw body>">`.
 * No "server-only": the worker imports this.
 */
import { z } from "zod";

import { callProvider, type Fetcher } from "./http";
import { hmacHex, sameSignature } from "./signature";
import {
  WebhookSignatureError,
  type LedgerMethod, type PaymentProvider, type ProviderEvent, type ProviderPayment,
} from "./types";

const API = "https://api.stripe.com/v1";
/** Stripe's own advice: reject a signed request older than five minutes, so a captured one cannot be replayed later. */
const TOLERANCE_SECONDS = 300;

export interface StripePlatform {
  secretKey: string;
}

function headers(platform: StripePlatform, accountId: string, extra: Record<string, string> = {}): HeadersInit {
  return {
    Authorization: `Bearer ${platform.secretKey}`,
    "Stripe-Account": accountId,
    "Content-Type": "application/x-www-form-urlencoded",
    ...extra,
  };
}

const sessionSchema = z.object({ id: z.string().min(1).max(120), url: z.string().url().nullable() });
const refundSchema = z.object({ id: z.string().min(1).max(80), status: z.string() });
const accountSchema = z.object({ id: z.string() }).passthrough();
const intentList = z.object({
  data: z.array(z.object({ id: z.string(), amount_received: z.number().int(), currency: z.string(), status: z.string() })),
  has_more: z.boolean(),
});

const eventSchema = z.object({
  id: z.string().min(1).max(120),
  type: z.string().max(80),
  account: z.string().max(80).optional(),
  data: z.object({ object: z.unknown() }),
});
const sessionObject = z.object({
  id: z.string(),
  payment_status: z.string(),
  payment_intent: z.string().nullish(),
  amount_total: z.number().int().nullish(),
  currency: z.string().nullish(),
  client_reference_id: z.string().nullish(),
});
const invoiceObject = z.object({
  id: z.string(),
  subscription: z.string().nullish(),
  amount_paid: z.number().int().nullish(),
  currency: z.string().nullish(),
  lines: z.object({ data: z.array(z.object({ period: z.object({ start: z.number().int(), end: z.number().int() }).nullish() })) }).nullish(),
});
const subscriptionObject = z.object({ id: z.string() });
const refundObject = z.object({
  id: z.string(),
  payment_intent: z.string().nullish(),
  amount: z.number().int(),
  currency: z.string(),
  status: z.string(),
});

function form(entries: Record<string, string | number>): string {
  return new URLSearchParams(Object.entries(entries).map(([key, value]) => [key, String(value)])).toString();
}

/** Stripe does not say which method paid in the session object we read; `other` is honest. */
const sessionMethod: LedgerMethod = "other";

/** The account id inside a verified Stripe webhook, read before the tenant is known (the route needs it to find the secret). */
export function stripeEventAccount(rawBody: string): string | null {
  try {
    const parsed = z.object({ account: z.string().max(80).optional() }).safeParse(JSON.parse(rawBody));
    return parsed.success ? parsed.data.account ?? null : null;
  } catch {
    return null;
  }
}

/** Verifies `Stripe-Signature` against one signing secret. Exported for the route and for tests. */
export function verifyStripeSignature(secret: string, rawBody: string, header: string | null, now: Date = new Date()): void {
  if (!header) throw new WebhookSignatureError();
  const parts = header.split(",").map((part) => part.trim().split("=") as [string, string]);
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value ?? "");
  const seconds = Number(timestamp);
  if (!timestamp || !Number.isFinite(seconds) || Math.abs(now.getTime() / 1000 - seconds) > TOLERANCE_SECONDS) throw new WebhookSignatureError();
  const expected = hmacHex(secret, `${timestamp}.${rawBody}`);
  if (!signatures.some((signature) => sameSignature(expected, signature))) throw new WebhookSignatureError();
}

export function createStripe(platform: StripePlatform, fetcher: Fetcher = fetch, now: () => Date = () => new Date()): PaymentProvider {
  return {
    id: "stripe",
    async verifyAccount(credentials) {
      await callProvider(fetcher, `${API}/account`, { method: "GET", headers: headers(platform, credentials.keyId) }, accountSchema);
    },
    async createOrder(credentials, input) {
      const session = await callProvider(fetcher, `${API}/checkout/sessions`, {
        method: "POST",
        headers: headers(platform, credentials.keyId, { "Idempotency-Key": `order-${input.reference}` }),
        body: form({
          mode: "payment",
          "line_items[0][quantity]": 1,
          "line_items[0][price_data][currency]": input.currency.toLowerCase(),
          "line_items[0][price_data][unit_amount]": input.amountMinor,
          "line_items[0][price_data][product_data][name]": input.description.slice(0, 120),
          client_reference_id: input.reference,
          success_url: input.returnUrl,
          cancel_url: input.returnUrl,
          // Stripe will not accept a session shorter than 30 minutes. The booking's own hold is shorter and is what frees the time.
          expires_at: Math.floor(Math.max(input.expiresAt.getTime(), now().getTime() + 31 * 60_000) / 1000),
        }),
      }, sessionSchema);
      return { providerOrderId: session.id, checkoutUrl: session.url };
    },
    async refund(credentials, input) {
      // The refund is against the payment intent; the session's payment id is stored as the intent id.
      const refund = await callProvider(fetcher, `${API}/refunds`, {
        method: "POST",
        headers: headers(platform, credentials.keyId, { "Idempotency-Key": input.idempotencyKey }),
        body: form({ payment_intent: input.providerPaymentId, amount: input.amountMinor }),
      }, refundSchema);
      return { providerRefundId: refund.id, status: refund.status === "succeeded" ? "processed" : "pending" };
    },
    async listPayments(credentials, window) {
      const found: ProviderPayment[] = [];
      let after: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const query = new URLSearchParams({ limit: "100", "created[gte]": String(Math.floor(window.from.getTime() / 1000)), "created[lt]": String(Math.floor(window.to.getTime() / 1000)) });
        if (after) query.set("starting_after", after);
        const result: z.infer<typeof intentList> = await callProvider(fetcher, `${API}/payment_intents?${query}`, { method: "GET", headers: headers(platform, credentials.keyId) }, intentList);
        found.push(...result.data.map((item): ProviderPayment => ({
          providerPaymentId: item.id, amountMinor: item.amount_received, currency: item.currency.toUpperCase(), captured: item.status === "succeeded",
        })));
        const last = result.data.at(-1);
        if (!result.has_more || !last) break;
        after = last.id;
      }
      return found;
    },
    parseWebhook(credentials, rawBody, header): ProviderEvent {
      verifyStripeSignature(credentials.webhookSecret, rawBody, header.get("stripe-signature"), now());
      let json: unknown;
      try { json = JSON.parse(rawBody); } catch { throw new WebhookSignatureError(); }
      const event = eventSchema.safeParse(json);
      if (!event.success) throw new WebhookSignatureError();
      const { id, type, data } = event.data;
      if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
        const session = sessionObject.safeParse(data.object);
        if (!session.success || session.data.payment_status !== "paid" || !session.data.payment_intent || session.data.amount_total == null || !session.data.currency) {
          return { kind: "ignored", eventId: id, type };
        }
        // The order id is the session id; the payment id is the payment intent, which is what refunds and the nightly check use.
        return { kind: "payment.captured", eventId: id, providerOrderId: session.data.id, providerPaymentId: session.data.payment_intent, amountMinor: session.data.amount_total, currency: session.data.currency.toUpperCase(), method: sessionMethod };
      }
      if (type === "checkout.session.async_payment_failed" || type === "checkout.session.expired") {
        const session = sessionObject.partial().safeParse(data.object);
        return { kind: "payment.failed", eventId: id, providerOrderId: session.success ? session.data.id ?? null : null, providerPaymentId: null };
      }
      if (type === "refund.updated" || type === "refund.created") {
        const refund = refundObject.safeParse(data.object);
        if (!refund.success || refund.data.status !== "succeeded" || !refund.data.payment_intent) return { kind: "ignored", eventId: id, type };
        return { kind: "refund.processed", eventId: id, providerPaymentId: refund.data.payment_intent, providerRefundId: refund.data.id, amountMinor: refund.data.amount, currency: refund.data.currency.toUpperCase() };
      }
      // Subscriptions (feature 25). Written from Stripe's documented events; not yet exercised against a live account.
      if (type === "invoice.paid" || type === "invoice.payment_failed") {
        const invoice = invoiceObject.safeParse(data.object);
        if (!invoice.success || !invoice.data.subscription) return { kind: "ignored", eventId: id, type };
        if (type === "invoice.payment_failed") return { kind: "subscription.payment_failed", eventId: id, providerSubscriptionId: invoice.data.subscription };
        const period = invoice.data.lines?.data[0]?.period;
        if (!period || !invoice.data.amount_paid || !invoice.data.currency) return { kind: "ignored", eventId: id, type };
        return {
          kind: "subscription.renewed", eventId: id, providerSubscriptionId: invoice.data.subscription, periodStart: new Date(period.start * 1000).toISOString(),
          periodEnd: new Date(period.end * 1000).toISOString(), amountMinor: invoice.data.amount_paid, currency: invoice.data.currency.toUpperCase(), method: sessionMethod,
        };
      }
      if (type === "customer.subscription.deleted" || type === "customer.subscription.paused") {
        const subscription = subscriptionObject.safeParse(data.object);
        return subscription.success
          ? { kind: "subscription.ended", eventId: id, providerSubscriptionId: subscription.data.id, reason: type === "customer.subscription.paused" ? "paused" : "cancelled" }
          : { kind: "ignored", eventId: id, type };
      }
      return { kind: "ignored", eventId: id, type };
    },
  };
}
