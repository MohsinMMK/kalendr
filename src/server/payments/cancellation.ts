/**
 * THE SEAM FOR CANCEL AND NO-SHOW (feature 42 calls this).
 *
 * `applyPaymentPolicy` decides what happens to money paid online when a visit is cancelled or missed, using the
 * rules the customer agreed to when they booked (stored on the appointment, never today's policy). It queues the
 * refund for the worker and calls no provider, so it is safe inside any request transaction:
 *
 *   await applyPaymentPolicy(drizzleRunner(transaction), { tenantId, appointmentId, event: "cancel", actorUserId });
 *
 * Call it in the same transaction that changes the status. Calling it twice for the same event does nothing
 * the second time. A visit with no online payment returns `{ action: "none" }`. It never edits a money row.
 * Staff can always refund more than the policy says from the visit's payments screen.
 *
 * No "server-only": the worker imports this.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";

import { afterWindowRules, decideRefund, noShowRules, type PolicyEvent } from "../../lib/payments";
import { asDate, type Runner } from "../workflows/runner";
import { onlinePayments, requestRefund } from "./ledger";

const termsSchema = z.object({
  depositMinor: z.number().int().nullable(),
  freeCancelHours: z.number().int().min(0),
  afterWindowRule: z.enum(afterWindowRules),
  noShowRule: z.enum(noShowRules),
});

export interface PolicyOutcome {
  action: "none" | "refunded" | "kept";
  /** Being handed back through the provider (the worker finishes it). */
  refundMinor: number;
  /** Kept by the business under the policy. */
  keptMinor: number;
  currency: string | null;
}

const NONE: PolicyOutcome = { action: "none", refundMinor: 0, keptMinor: 0, currency: null };

/** Which policy event a mutation's outbox action stands for, or null when the money is not affected. */
export function policyEventFor(action: string): PolicyEvent | null {
  if (action === "appointment.cancel" || action === "appointment.status.cancelled") return "cancel";
  if (action === "appointment.status.no_show") return "no_show";
  return null;
}

export async function applyPaymentPolicy(run: Runner, input: {
  tenantId: string;
  appointmentId: string;
  event: PolicyEvent;
  actorUserId?: string | null;
  now?: Date;
}): Promise<PolicyOutcome> {
  const payments = await onlinePayments(run, input.tenantId, input.appointmentId, true);
  if (payments.length === 0) return NONE;
  const [appointment] = await run(sql`select starts_at, payment_terms from appointments where tenant_id = ${input.tenantId} and id = ${input.appointmentId}`);
  if (!appointment) return NONE;
  const terms = termsSchema.safeParse(appointment.payment_terms);
  // A visit paid for before the terms were stored is treated like a cancellation outside the window: nothing is refunded by rule.
  if (!terms.success) return { ...NONE, action: "kept", keptMinor: payments.reduce((total, payment) => total + payment.refundableMinor, 0), currency: payments[0]!.currency };

  const refundable = payments.reduce((total, payment) => total + payment.refundableMinor, 0);
  const decision = decideRefund({
    event: input.event,
    policy: terms.data,
    startsAt: asDate(appointment.starts_at),
    now: input.now ?? new Date(),
    paidOnlineMinor: refundable,
    depositMinor: terms.data.depositMinor,
  });

  let left = decision.refundMinor;
  let queued = 0;
  for (const payment of payments) {
    if (left <= 0) break;
    const amount = Math.min(left, payment.refundableMinor);
    if (amount <= 0) continue;
    const result = await requestRefund(run, {
      tenantId: input.tenantId,
      paymentId: payment.id,
      amountMinor: amount,
      reason: input.event === "cancel" ? "Cancelled under the refund policy" : "No-show: paid beyond the deposit",
      source: "policy",
      dedupeKey: `policy:${input.event}:${input.appointmentId}:${payment.id}`,
      requestedByUserId: input.actorUserId ?? null,
    }, { clamp: true });
    if (result.status === "queued") { queued += result.amountMinor; left -= result.amountMinor; }
  }
  // The audit trail records the outcome in numbers only (no free text).
  await run(sql`
    insert into audit_events (tenant_id, appointment_id, actor_user_id, actor_type, action, outcome, metadata)
    values (${input.tenantId}, ${input.appointmentId}, ${input.actorUserId ?? null}, ${input.actorUserId ? "staff" : "patient"}, 'payment.policy_applied', 'success',
      ${JSON.stringify({ event: input.event, refundMinor: queued, keptMinor: decision.keptMinor })}::text::jsonb)`);
  return { action: queued > 0 ? "refunded" : "kept", refundMinor: queued, keptMinor: decision.keptMinor, currency: payments[0]!.currency };
}

