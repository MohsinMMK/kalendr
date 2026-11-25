/**
 * Online payments on the one ledger (`payments`, `payment_refunds`). Written against `Runner` so the same
 * code runs in the web server's drizzle transaction and in the worker's postgres.js transaction.
 *
 * Money rows are only ever inserted. A refund goes through two steps: a `refund_requests` row (mutable, says
 * "give this back"), then, once the provider has paid it out, a `payment_refunds` row in the ledger.
 * No "server-only": the worker imports this.
 */
import { sql } from "drizzle-orm";

import { asNumber, asString, type Runner } from "../workflows/runner";

export const REFUND_EVENT = "refund.process";

export interface OnlinePayment {
  id: string;
  appointmentId: string;
  amountMinor: number;
  currency: string;
  provider: string;
  providerPaymentId: string;
  isTest: boolean;
  /** Still giveable back: what was paid, less refunds paid out and refunds already asked for. */
  refundableMinor: number;
}

/** The visit's payments taken online, oldest first, each with what can still be given back. */
export async function onlinePayments(run: Runner, tenantId: string, appointmentId: string, lock = false): Promise<OnlinePayment[]> {
  const rows = await run(lock
    ? sql`select id, appointment_id, amount_minor, currency, provider, provider_payment_id, is_test from payments
        where tenant_id = ${tenantId} and appointment_id = ${appointmentId} and provider is not null order by created_at, id for update`
    : sql`select id, appointment_id, amount_minor, currency, provider, provider_payment_id, is_test from payments
        where tenant_id = ${tenantId} and appointment_id = ${appointmentId} and provider is not null order by created_at, id`);
  const found: OnlinePayment[] = [];
  for (const row of rows) {
    const id = asString(row.id);
    found.push({
      id, appointmentId: asString(row.appointment_id), amountMinor: asNumber(row.amount_minor), currency: asString(row.currency),
      provider: asString(row.provider), providerPaymentId: asString(row.provider_payment_id), isTest: row.is_test === true,
      refundableMinor: await refundableMinor(run, tenantId, id, asNumber(row.amount_minor)),
    });
  }
  return found;
}

/** What can still be given back against one payment. Counts refunds already asked for, so two requests cannot add up to more. */
export async function refundableMinor(run: Runner, tenantId: string, paymentId: string, amountMinor: number): Promise<number> {
  const [done] = await run(sql`select coalesce(sum(amount_minor), 0) as total from payment_refunds where tenant_id = ${tenantId} and payment_id = ${paymentId}`);
  const [pending] = await run(sql`select coalesce(sum(amount_minor), 0) as total from refund_requests where tenant_id = ${tenantId} and payment_id = ${paymentId} and status = 'pending'`);
  return Math.max(0, amountMinor - asNumber(done?.total) - asNumber(pending?.total));
}

export type RefundSource = "policy" | "staff" | "late_payment" | "reschedule";

export interface RefundAsk {
  tenantId: string;
  paymentId: string;
  amountMinor: number;
  reason: string;
  source: RefundSource;
  /** Asking twice with the same key does nothing the second time. */
  dedupeKey: string;
  requestedByUserId?: string | null;
}

export type RefundAskResult = { status: "queued"; requestId: string; amountMinor: number } | { status: "duplicate" } | { status: "nothing_to_refund" } | { status: "too_much"; refundableMinor: number };

/**
 * Asks for money back against one online payment. Locks the payment so two asks cannot overshoot it, then
 * queues the provider call for the worker. The provider is never called here.
 */
export async function requestRefund(run: Runner, ask: RefundAsk, options: { clamp?: boolean } = {}): Promise<RefundAskResult> {
  const [payment] = await run(sql`select id, amount_minor from payments where tenant_id = ${ask.tenantId} and id = ${ask.paymentId} and provider is not null for update`);
  if (!payment) return { status: "nothing_to_refund" };
  const refundable = await refundableMinor(run, ask.tenantId, ask.paymentId, asNumber(payment.amount_minor));
  let amount = ask.amountMinor;
  if (amount > refundable) {
    if (!options.clamp) return { status: "too_much", refundableMinor: refundable };
    amount = refundable;
  }
  if (amount <= 0) return { status: "nothing_to_refund" };
  const inserted = await run(sql`
    insert into refund_requests (tenant_id, payment_id, amount_minor, reason, source, dedupe_key, requested_by_user_id)
    values (${ask.tenantId}, ${ask.paymentId}, ${amount}, ${ask.reason.slice(0, 200)}, ${ask.source}, ${ask.dedupeKey.slice(0, 160)}, ${ask.requestedByUserId ?? null})
    on conflict (tenant_id, dedupe_key) do nothing
    returning id`);
  const created = inserted[0];
  if (!created) return { status: "duplicate" };
  const requestId = asString(created.id);
  await queueRefundSend(run, ask.tenantId, requestId);
  return { status: "queued", requestId, amountMinor: amount };
}

/** One outbox row per refund; the worker makes the provider call. A repeat of the same request queues nothing new. */
export async function queueRefundSend(run: Runner, tenantId: string, requestId: string, attempt = 0): Promise<void> {
  await run(sql`
    insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
    values (${tenantId}, 'refund_request', ${requestId}, ${REFUND_EVENT}, ${JSON.stringify({ refundRequestId: requestId })}::text::jsonb, ${`refund.process:${requestId}:${attempt}`})
    on conflict (tenant_id, dedupe_key) do nothing`);
}

/**
 * Writes the ledger row for a refund the provider has paid out, and closes the request. Safe to call twice and
 * from two places (the worker after the API answered, and the webhook): the unique ids make the second a no-op.
 */
export async function recordRefundPaid(run: Runner, input: {
  tenantId: string; paymentId: string; amountMinor: number; providerRefundId: string; requestId: string | null; reason: string; isTest: boolean;
}): Promise<boolean> {
  const inserted = await run(sql`
    insert into payment_refunds (tenant_id, payment_id, amount_minor, reason, request_id, provider_refund_id, is_test)
    values (${input.tenantId}, ${input.paymentId}, ${input.amountMinor}, ${input.reason.slice(0, 200)}, ${input.requestId}, ${input.providerRefundId}, ${input.isTest})
    on conflict do nothing
    returning id`);
  if (input.requestId) {
    await run(sql`
      update refund_requests set status = 'done', provider_refund_id = ${input.providerRefundId}, updated_at = now()
      where tenant_id = ${input.tenantId} and id = ${input.requestId} and status = 'pending'`);
  }
  return inserted.length > 0;
}
