import { outboxEvents } from "@/db/schema";
import type { KalendrTransaction } from "@/db/client";
import { currentTraceParent } from "@/server/tracing";

/**
 * Outbox rows that the worker turns into outgoing webhooks (feature 34). A row is queued in the same transaction as
 * the change it describes, so the event exists exactly when the change does. The worker looks up which addresses
 * subscribed; nothing here calls out.
 */

/** A customer was created by the API, an import or the staff desk. Carries the id only. */
export async function queueCustomerCreated(transaction: KalendrTransaction, tenantId: string, customerId: string): Promise<void> {
  await transaction.insert(outboxEvents).values({
    tenantId,
    aggregateType: "customer",
    aggregateId: customerId,
    eventType: "customer.created",
    payload: { customerId },
    dedupeKey: `customer.created:${customerId}`,
    traceParent: currentTraceParent(),
  }).onConflictDoNothing();
}

/** Money was captured for an appointment. Lane D (payments) calls this where a payment is recorded as captured. */
export async function queuePaymentCaptured(
  transaction: KalendrTransaction,
  tenantId: string,
  payment: { paymentId: string; appointmentId: string | null; amountMinor: number; currency: string },
): Promise<void> {
  await transaction.insert(outboxEvents).values({
    tenantId,
    aggregateType: "payment",
    aggregateId: payment.paymentId,
    eventType: "payment.captured",
    payload: { ...payment },
    dedupeKey: `payment.captured:${payment.paymentId}`,
    traceParent: currentTraceParent(),
  }).onConflictDoNothing();
}
