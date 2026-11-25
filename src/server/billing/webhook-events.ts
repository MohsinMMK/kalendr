import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type { BillingProvider } from "../../lib/billing-contracts";

/**
 * Provider webhook bodies for subscription billing: signature checks, and the small allow-listed extract that is
 * stored. The extract holds ids, status, amounts, currency, period times and plan ids and nothing else: never a
 * card or UPI detail, email, phone, name, or the raw provider body. No "server-only": unit tests import this.
 */

/** Outbox event types of subscription billing. */
export const BILLING_EVENT = "billing.event";
export const BILLING_EMAIL_EVENT = "billing.email";
export const BILLING_PROVIDER_EVENT = "billing.provider_change";

export const MAX_BILLING_WEBHOOK_BYTES = 256 * 1024;
/** Stripe's own default: a signature older than five minutes is refused, which stops a captured request being replayed. */
export const STRIPE_TOLERANCE_SECONDS = 300;

function safeEqualHex(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Razorpay: HMAC-SHA256 of the raw body with the webhook secret, hex, in X-Razorpay-Signature. */
export function verifyRazorpaySignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false;
  return safeEqualHex(createHmac("sha256", secret).update(rawBody, "utf8").digest("hex"), signature.trim());
}

/** Stripe: `t=<unix>,v1=<hex>[,v1=...]`, where v1 signs `<t>.<raw body>`. Several v1 values appear while a secret rotates. */
export function verifyStripeSignature(rawBody: string, header: string | null, secret: string, now: Date = new Date()): boolean {
  if (!header || !secret) return false;
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key?.trim() === "t" && value) timestamp = value.trim();
    if (key?.trim() === "v1" && value) signatures.push(value.trim());
  }
  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds) || signatures.length === 0) return false;
  if (Math.abs(now.getTime() / 1000 - seconds) > STRIPE_TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return signatures.some((signature) => safeEqualHex(expected, signature));
}

/** What is kept of an event. Everything optional: each event type fills what it carries. */
export interface BillingEventExtract {
  provider: BillingProvider;
  eventId: string;
  type: string;
  /** From notes or metadata. Unverified until the business row exists: a bad id fails the foreign key and is dropped. */
  tenantId: string | null;
  providerSubscriptionId: string | null;
  providerCustomerId: string | null;
  /** Razorpay payment id, or the Stripe invoice id: one per charge, so an invoice is made once per charge. */
  providerPaymentId: string | null;
  providerPlanId: string | null;
  planKey: string | null;
  status: string | null;
  amountMinor: number | null;
  currency: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean | null;
  occurredAt: string | null;
}

const empty = (provider: BillingProvider, eventId: string, type: string): BillingEventExtract => ({
  provider, eventId, type, tenantId: null, providerSubscriptionId: null, providerCustomerId: null, providerPaymentId: null,
  providerPlanId: null, planKey: null, status: null, amountMinor: null, currency: null, periodStart: null, periodEnd: null,
  cancelAtPeriodEnd: null, occurredAt: null,
});

const text = z.string().max(200).optional().nullable();
const epoch = (value: number | null | undefined): string | null => (typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null);
/** Razorpay sends `notes` as an empty array when there are none. */
const notes = z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional().nullable();
const noteOf = (value: z.infer<typeof notes>, key: string): string | null => {
  if (!value || Array.isArray(value)) return null;
  const item = value[key];
  return typeof item === "string" && item.length > 0 && item.length <= 200 ? item : null;
};

const razorpayBody = z.object({
  event: z.string().max(100),
  created_at: z.number().optional(),
  payload: z.object({
    subscription: z.object({ entity: z.object({
      id: text, plan_id: text, customer_id: text, status: text, notes,
      current_start: z.number().nullable().optional(), current_end: z.number().nullable().optional(),
    }) }).optional(),
    payment: z.object({ entity: z.object({
      id: text, amount: z.number().int().optional(), currency: text, status: text, notes, subscription_id: text, customer_id: text,
    }) }).optional(),
  }).optional(),
});

export function extractRazorpayEvent(rawBody: string, eventIdHeader: string | null): BillingEventExtract | null {
  let json: unknown;
  try { json = JSON.parse(rawBody); } catch { return null; }
  const parsed = razorpayBody.safeParse(json);
  if (!parsed.success) return null;
  const body = parsed.data;
  // Razorpay sends x-razorpay-event-id on every delivery; the body hash is only a fallback for a missing header.
  const eventId = eventIdHeader?.trim() || `body:${createHash("sha256").update(rawBody).digest("hex")}`;
  const extract = empty("razorpay", eventId.slice(0, 200), body.event);
  const subscription = body.payload?.subscription?.entity;
  const payment = body.payload?.payment?.entity;
  extract.providerSubscriptionId = subscription?.id ?? payment?.subscription_id ?? null;
  extract.providerCustomerId = subscription?.customer_id ?? payment?.customer_id ?? null;
  extract.providerPlanId = subscription?.plan_id ?? null;
  extract.tenantId = noteOf(subscription?.notes, "tenantId") ?? noteOf(payment?.notes, "tenantId");
  extract.planKey = noteOf(subscription?.notes, "planKey") ?? noteOf(payment?.notes, "planKey");
  extract.status = subscription?.status ?? payment?.status ?? null;
  extract.providerPaymentId = payment?.id ?? null;
  extract.amountMinor = payment?.amount ?? null;
  extract.currency = payment?.currency ? payment.currency.toUpperCase() : null;
  extract.periodStart = epoch(subscription?.current_start);
  extract.periodEnd = epoch(subscription?.current_end);
  extract.occurredAt = epoch(body.created_at);
  return extract;
}

const stripeItem = z.object({
  price: z.object({ id: text }).optional().nullable(),
  current_period_start: z.number().optional(), current_period_end: z.number().optional(),
});
const stripeObject = z.object({
  id: text, customer: text, subscription: text, status: text, mode: text, currency: text,
  client_reference_id: text,
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  cancel_at_period_end: z.boolean().optional(),
  amount_paid: z.number().int().optional(), amount_due: z.number().int().optional(),
  items: z.object({ data: z.array(stripeItem) }).optional(),
  parent: z.object({ subscription_details: z.object({ subscription: text, metadata: z.record(z.string(), z.unknown()).optional().nullable() }).optional().nullable() }).optional().nullable(),
  lines: z.object({ data: z.array(z.object({
    period: z.object({ start: z.number().optional(), end: z.number().optional() }).optional(),
    pricing: z.object({ price_details: z.object({ price: text }).optional().nullable() }).optional().nullable(),
  })) }).optional(),
});
const stripeBody = z.object({ id: z.string().max(200), type: z.string().max(100), created: z.number().optional(), data: z.object({ object: stripeObject }) });

const metaOf = (value: Record<string, unknown> | null | undefined, key: string): string | null => {
  const item = value?.[key];
  return typeof item === "string" && item.length > 0 && item.length <= 200 ? item : null;
};

export function extractStripeEvent(rawBody: string): BillingEventExtract | null {
  let json: unknown;
  try { json = JSON.parse(rawBody); } catch { return null; }
  const parsed = stripeBody.safeParse(json);
  if (!parsed.success) return null;
  const { id, type, created, data } = parsed.data;
  const object = data.object;
  const extract = empty("stripe", id, type);
  const isInvoice = type.startsWith("invoice.");
  const isSubscription = type.startsWith("customer.subscription.");
  const invoiceDetails = object.parent?.subscription_details;
  extract.providerCustomerId = object.customer ?? null;
  extract.providerSubscriptionId = isSubscription ? object.id ?? null : isInvoice ? invoiceDetails?.subscription ?? null : object.subscription ?? null;
  const metadata = isInvoice ? invoiceDetails?.metadata ?? object.metadata : object.metadata;
  extract.tenantId = metaOf(metadata, "tenantId") ?? object.client_reference_id ?? null;
  extract.planKey = metaOf(metadata, "planKey");
  extract.status = object.status ?? null;
  extract.currency = object.currency ? object.currency.toUpperCase() : null;
  extract.occurredAt = epoch(created);
  if (isSubscription) {
    const item = object.items?.data[0];
    extract.providerPlanId = item?.price?.id ?? null;
    extract.periodStart = epoch(item?.current_period_start);
    extract.periodEnd = epoch(item?.current_period_end);
    extract.cancelAtPeriodEnd = object.cancel_at_period_end ?? null;
  }
  if (isInvoice) {
    const line = object.lines?.data[0];
    extract.providerPaymentId = object.id ?? null;
    extract.amountMinor = type === "invoice.paid" ? object.amount_paid ?? null : object.amount_due ?? null;
    extract.providerPlanId = line?.pricing?.price_details?.price ?? null;
    extract.periodStart = epoch(line?.period?.start);
    extract.periodEnd = epoch(line?.period?.end);
  }
  return extract;
}

/** A stored extract read back from `billing_events.payload`. Parsed again because it crossed the database. */
export const billingEventExtractSchema = z.object({
  provider: z.enum(["razorpay", "stripe"]), eventId: z.string(), type: z.string(),
  tenantId: z.string().nullable(), providerSubscriptionId: z.string().nullable(), providerCustomerId: z.string().nullable(),
  providerPaymentId: z.string().nullable(), providerPlanId: z.string().nullable(), planKey: z.string().nullable(),
  status: z.string().nullable(), amountMinor: z.number().int().nullable(), currency: z.string().nullable(),
  periodStart: z.string().nullable(), periodEnd: z.string().nullable(), cancelAtPeriodEnd: z.boolean().nullable(), occurredAt: z.string().nullable(),
});
