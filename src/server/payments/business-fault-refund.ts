/**
 * Money back in full when the business, not the customer, ended a booking (feature 42 calling feature 23).
 *
 * `applyPaymentPolicy` (cancellation.ts) applies the policy the customer agreed to, which suits a customer who
 * cancels late. It does not suit a visit the business missed, or one it asked the customer to move that nobody
 * rebooked: there the customer gets everything still refundable. Like the policy, this only queues refunds for the
 * worker and calls no provider, so it is safe inside any request or worker transaction. Asking twice does nothing.
 *
 * No "server-only": the worker imports this.
 */
import { onlinePayments, requestRefund, type RefundSource } from "./ledger";
import type { Runner } from "../workflows/runner";

export interface FullRefundResult {
  refundedMinor: number;
}

export async function refundInFull(run: Runner, input: {
  tenantId: string;
  appointmentId: string;
  /** `staff` for a business no-show, `reschedule` for a move nobody answered. */
  source: Extract<RefundSource, "staff" | "reschedule">;
  reason: string;
  actorUserId?: string | null;
}): Promise<FullRefundResult> {
  const payments = await onlinePayments(run, input.tenantId, input.appointmentId, true);
  let refundedMinor = 0;
  for (const payment of payments) {
    if (payment.refundableMinor <= 0) continue;
    const result = await requestRefund(run, {
      tenantId: input.tenantId,
      paymentId: payment.id,
      amountMinor: payment.refundableMinor,
      reason: input.reason,
      source: input.source,
      dedupeKey: `business-fault:${input.source}:${input.appointmentId}:${payment.id}`,
      requestedByUserId: input.actorUserId ?? null,
    }, { clamp: true });
    if (result.status === "queued") refundedMinor += result.amountMinor;
  }
  return { refundedMinor };
}
