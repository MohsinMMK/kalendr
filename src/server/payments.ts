import "server-only";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { withTenant, type KalendrTransaction as TenantTransaction } from "@/db/client";
import { appointmentLink } from "@/lib/staff-alerts";
import { notifyStaff } from "./staff-notifications";
import { auditEvents, paymentRefunds, payments, refundRequests, tenants } from "@/db/schema";
import { formatMoney, MAX_PAYMENT_MINOR, visitBalance, type VisitBalance } from "@/lib/money";

import { ApiError } from "./api-error";
import { claimKey, finishKey } from "./idempotent";
import { assertAppointmentVisibleHere } from "./location-scope";
import { isPreviewMode } from "./preview-repository";
import { requirePermission, type StaffContext } from "./staff-context";
import { requestRefund } from "./payments/ledger";
import { drizzleRunner } from "./workflows/runner";

/** What the desk can pick. */
export const paymentMethods = ["cash", "upi", "card", "bank"] as const;
/** Everything the ledger can hold: online payments the provider could not name as one of the four are `other`. */
export const ledgerMethods = [...paymentMethods, "other"] as const;
export type PaymentMethod = (typeof ledgerMethods)[number];

const amountSchema = z.number().int().positive().max(MAX_PAYMENT_MINOR);

/** Only the method is taken. Card numbers, UPI IDs and bank details are never asked for or kept. */
export const recordPaymentInputSchema = z.strictObject({
  amountMinor: amountSchema,
  method: z.enum(paymentMethods),
});

export const refundInputSchema = z.strictObject({
  amountMinor: amountSchema,
  reason: z.string().trim().min(2).max(200),
});

export interface RefundView {
  id: string;
  amountMinor: number;
  reason: string;
  at: string;
  /** `pending` is asked for and not yet paid out by the provider (online payments only). */
  status: "done" | "pending";
}

export interface PaymentView {
  id: string;
  amountMinor: number;
  method: PaymentMethod;
  at: string;
  refunds: RefundView[];
  /** What can still be given back against this payment. Refunds already asked for count as given. */
  refundableMinor: number;
  /** Online payments (feature 23): who took it, whether it was a test, and refunds asked for but not paid out yet. Null and 0 for the desk's own. */
  provider: "razorpay" | "stripe" | "fake" | null;
  isTest: boolean;
  pendingRefundMinor: number;
}

/** What a refund of a payment with no visit (a package or membership sale) returns: the money is the desk's own, so it is paid back at once. */
export interface SalePaymentRefund {
  paymentId: string;
  refundId: string;
  amountMinor: number;
  currency: string;
  refundQueued: false;
}

export interface VisitPayments {
  appointmentId: string;
  currency: string;
  balance: VisitBalance;
  payments: PaymentView[];
  /** True when the refund just asked for goes through the provider and is not paid out yet (the route answers 202). */
  refundQueued?: boolean;
}

const COLLECT_ROUTE = "staff.payments.collect";
const REFUND_ROUTE = "staff.payments.refund";

function refusePreview(context: StaffContext): void {
  if (context.preview || isPreviewMode()) throw new ApiError(409, "preview_only", "Payments are kept in the browser in the preview.");
}

async function lockVisit(transaction: TenantTransaction, tenantId: string, appointmentId: string) {
  const [row] = await transaction.execute<{ id: string; price_minor: number | null; status: string }>(sql`
    select id, price_minor, status::text as status from appointments
    where tenant_id = ${tenantId} and id = ${appointmentId}
    for update
  `);
  if (!row) throw new ApiError(404, "appointment_not_found", "That visit could not be found.");
  return row;
}

async function loadVisitPayments(transaction: TenantTransaction, tenantId: string, appointmentId: string, priceMinor: number | null): Promise<VisitPayments> {
  const [tenant] = await transaction.select({ currency: tenants.currency }).from(tenants).where(eq(tenants.id, tenantId));
  const paymentRows = await transaction.select().from(payments)
    .where(and(eq(payments.tenantId, tenantId), eq(payments.appointmentId, appointmentId)))
    .orderBy(asc(payments.createdAt));
  const refundRows = paymentRows.length === 0 ? [] : await transaction.select().from(paymentRefunds)
    .where(and(eq(paymentRefunds.tenantId, tenantId), inArray(paymentRefunds.paymentId, paymentRows.map((row) => row.id))))
    .orderBy(asc(paymentRefunds.createdAt));
  const pendingRows = paymentRows.length === 0 ? [] : await transaction.select().from(refundRequests)
    .where(and(eq(refundRequests.tenantId, tenantId), eq(refundRequests.status, "pending"), inArray(refundRequests.paymentId, paymentRows.map((row) => row.id))))
    .orderBy(asc(refundRequests.createdAt));
  const views = paymentRows.map((row): PaymentView => {
    const done = refundRows.filter((refund) => refund.paymentId === row.id).map((refund): RefundView => ({
      id: refund.id, amountMinor: refund.amountMinor, reason: refund.reason, at: refund.createdAt.toISOString(), status: "done",
    }));
    const waiting = pendingRows.filter((request) => request.paymentId === row.id).map((request): RefundView => ({
      id: request.id, amountMinor: request.amountMinor, reason: request.reason, at: request.createdAt.toISOString(), status: "pending",
    }));
    const refunded = done.reduce((total, refund) => total + refund.amountMinor, 0);
    const pending = waiting.reduce((total, refund) => total + refund.amountMinor, 0);
    return {
      id: row.id, amountMinor: row.amountMinor, method: row.method, at: row.createdAt.toISOString(), refunds: [...done, ...waiting],
      refundableMinor: Math.max(0, row.amountMinor - refunded - pending), provider: row.provider as PaymentView["provider"], isTest: row.isTest, pendingRefundMinor: pending,
    };
  });
  // The balance only moves when money has really gone back, not when a refund is merely asked for.
  const paid = views.reduce((total, view) => total + view.amountMinor, 0);
  const refunded = views.reduce((total, view) => total + view.amountMinor - view.refundableMinor - view.pendingRefundMinor, 0);
  return { appointmentId, currency: tenant?.currency ?? "INR", balance: visitBalance(priceMinor, paid, refunded), payments: views };
}

/** Payments and refunds for one visit, oldest first, with what is still due. */
export async function getVisitPayments(context: StaffContext, appointmentId: string): Promise<VisitPayments> {
  requirePermission(context, "payments.collect");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const [visit] = await transaction.execute<{ price_minor: number | null }>(sql`
      select price_minor from appointments where tenant_id = ${context.tenantId} and id = ${appointmentId}
    `);
    if (!visit) throw new ApiError(404, "appointment_not_found", "That visit could not be found.");
    await assertAppointmentVisibleHere(transaction, context, appointmentId);
    return loadVisitPayments(transaction, context.tenantId, appointmentId, visit.price_minor);
  });
}

/** Records money taken at the desk. More than is due is refused, so a typo cannot overcharge. */
export async function recordPayment(
  context: StaffContext,
  appointmentId: string,
  input: z.infer<typeof recordPaymentInputSchema>,
  idempotencyKey: string,
): Promise<VisitPayments> {
  requirePermission(context, "payments.collect");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const claim = await claimKey<VisitPayments>(transaction, context.tenantId, COLLECT_ROUTE, idempotencyKey, { appointmentId, ...input });
    if ("replay" in claim) return claim.replay;
    await assertAppointmentVisibleHere(transaction, context, appointmentId);
    const visit = await lockVisit(transaction, context.tenantId, appointmentId);
    if (visit.status === "cancelled") throw new ApiError(409, "appointment_cancelled", "This visit was cancelled. Payments can't be taken for it.");
    const before = await loadVisitPayments(transaction, context.tenantId, appointmentId, visit.price_minor);
    if (before.balance.priceMinor !== null && input.amountMinor > before.balance.dueMinor) {
      throw new ApiError(409, "payment_exceeds_due", before.balance.dueMinor === 0
        ? "This visit is already paid."
        : `Only ${formatMoney(before.balance.dueMinor, before.currency)} is due.`);
    }
    const [row] = await transaction.insert(payments).values({
      tenantId: context.tenantId, appointmentId, amountMinor: input.amountMinor, currency: before.currency,
      method: input.method, recordedByUserId: context.userId,
    }).returning({ id: payments.id });
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, appointmentId, actorUserId: context.userId, actorType: "staff",
      action: "payment.recorded", outcome: "success",
      metadata: { paymentId: row!.id, amountMinor: input.amountMinor, currency: before.currency, method: input.method },
    });
    const after = await loadVisitPayments(transaction, context.tenantId, appointmentId, visit.price_minor);
    await notifyStaff(transaction, context.tenantId, {
      kind: "payment", appointmentId, dedupeKey: `payment:${row!.id}`, exceptUserId: context.userId, link: appointmentLink(appointmentId),
    });
    await finishKey(transaction, claim.claimId, after);
    return after;
  });
}

/** Gives money back against one payment. All refunds on it together never exceed it. */
export async function refundPayment(
  context: StaffContext,
  paymentId: string,
  input: z.infer<typeof refundInputSchema>,
  idempotencyKey: string,
): Promise<VisitPayments | SalePaymentRefund> {
  requirePermission(context, "payments.refund");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const claim = await claimKey<VisitPayments | SalePaymentRefund>(transaction, context.tenantId, REFUND_ROUTE, idempotencyKey, { paymentId, ...input });
    if ("replay" in claim) return claim.replay;
    const [payment] = await transaction.execute<{ appointment_id: string | null; amount_minor: number; currency: string; provider: string | null; invoice_id: string | null }>(sql`
      select appointment_id, amount_minor, currency, provider, invoice_id from payments
      where tenant_id = ${context.tenantId} and id = ${paymentId}
      for update
    `);
    if (!payment) throw new ApiError(404, "payment_not_found", "That payment could not be found.");
    if (payment.appointment_id === null) {
      // A package or membership sale has no visit. It was taken at the desk (or by a subscription), so the refund is the desk's own row.
      const [given] = await transaction.execute<{ total: number | string | null }>(sql`
        select sum(amount_minor) as total from payment_refunds where tenant_id = ${context.tenantId} and payment_id = ${paymentId}`);
      const left = payment.amount_minor - Number(given?.total ?? 0);
      if (input.amountMinor > left) {
        throw new ApiError(409, "refund_exceeds_payment", left === 0
          ? "This payment has already been given back in full."
          : `Only ${formatMoney(left, payment.currency)} of this payment can still be given back.`);
      }
      const [refund] = await transaction.insert(paymentRefunds).values({
        tenantId: context.tenantId, paymentId, amountMinor: input.amountMinor, reason: input.reason, recordedByUserId: context.userId,
      }).returning({ id: paymentRefunds.id });
      await transaction.insert(auditEvents).values({
        tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "payment.refunded", outcome: "success",
        metadata: { paymentId, refundId: refund!.id, invoiceId: payment.invoice_id, amountMinor: input.amountMinor, currency: payment.currency },
      });
      const done: SalePaymentRefund = { paymentId, refundId: refund!.id, amountMinor: input.amountMinor, currency: payment.currency, refundQueued: false };
      await finishKey(transaction, claim.claimId, done);
      return done;
    }
    await assertAppointmentVisibleHere(transaction, context, payment.appointment_id);
    const visit = await lockVisit(transaction, context.tenantId, payment.appointment_id);
    if (payment.provider) {
      // Money taken online goes back through the provider. This only asks for it; the worker sends it and the ledger row follows (feature 23).
      const asked = await requestRefund(drizzleRunner(transaction), {
        tenantId: context.tenantId, paymentId, amountMinor: input.amountMinor, reason: input.reason, source: "staff", dedupeKey: `staff:${idempotencyKey}`, requestedByUserId: context.userId,
      });
      if (asked.status === "too_much") {
        throw new ApiError(409, "refund_exceeds_payment", asked.refundableMinor === 0
          ? "This payment has already been given back in full."
          : `Only ${formatMoney(asked.refundableMinor, payment.currency)} of this payment can still be given back.`);
      }
      // The reason is free text, so it stays out of the activity log.
      await transaction.insert(auditEvents).values({
        tenantId: context.tenantId, appointmentId: payment.appointment_id, actorUserId: context.userId, actorType: "staff",
        action: "payment.refund_requested", outcome: "success", metadata: { paymentId, amountMinor: input.amountMinor, currency: payment.currency },
      });
      const queued = { ...(await loadVisitPayments(transaction, context.tenantId, payment.appointment_id, visit.price_minor)), refundQueued: true };
      await finishKey(transaction, claim.claimId, queued);
      return queued;
    }
    const [refunded] = await transaction.execute<{ total: number | string | null }>(sql`
      select sum(amount_minor) as total from payment_refunds where tenant_id = ${context.tenantId} and payment_id = ${paymentId}
    `);
    const refundable = payment.amount_minor - Number(refunded?.total ?? 0);
    if (input.amountMinor > refundable) {
      throw new ApiError(409, "refund_exceeds_payment", refundable === 0
        ? "This payment has already been given back in full."
        : `Only ${formatMoney(refundable, payment.currency)} of this payment can still be given back.`);
    }
    const [row] = await transaction.insert(paymentRefunds).values({
      tenantId: context.tenantId, paymentId, amountMinor: input.amountMinor, reason: input.reason, recordedByUserId: context.userId,
    }).returning({ id: paymentRefunds.id });
    // The reason is free text the desk typed, so it stays out of the activity log.
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, appointmentId: payment.appointment_id, actorUserId: context.userId, actorType: "staff",
      action: "payment.refunded", outcome: "success",
      metadata: { paymentId, refundId: row!.id, amountMinor: input.amountMinor, currency: payment.currency },
    });
    const after = await loadVisitPayments(transaction, context.tenantId, payment.appointment_id, visit.price_minor);
    await finishKey(transaction, claim.claimId, after);
    return after;
  });
}
