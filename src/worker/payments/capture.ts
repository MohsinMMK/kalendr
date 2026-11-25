import { sql } from "drizzle-orm";

import { planAppointment } from "../../server/workflows/engine";
import { asDate, asString, postgresRunner, type Runner } from "../../server/workflows/runner";
import { requestRefund } from "../../server/payments/ledger";
import type { LedgerMethod } from "../../server/payments/types";
import type { TenantDb } from "../handlers/types";
import { alertStaff } from "./alerts";

export interface CapturedPayment {
  provider: string;
  providerOrderId: string;
  providerPaymentId: string;
  amountMinor: number;
  currency: string;
  method: LedgerMethod;
}

export type CaptureResult = "recorded" | "already_recorded" | "unknown_order" | "amount_differs";

/** Postgres says "exclusion_violation" when another booking took the time. */
const EXCLUSION_VIOLATION = "23P01";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

async function noteMismatch(run: Runner, tenantId: string, accountId: string, kind: "missing_here" | "amount_differs", paymentId: string, providerAmount: number | null, ledgerAmount: number | null): Promise<void> {
  await run(sql`
    insert into payment_mismatches (tenant_id, account_id, day, kind, provider_payment_id, provider_amount_minor, ledger_amount_minor)
    values (${tenantId}, ${accountId}, current_date, ${kind}, ${paymentId}, ${providerAmount}, ${ledgerAmount})
    on conflict do nothing`);
}

/**
 * The provider says money was captured. Inside one transaction: check it against the order, write the ledger row once,
 * and (if the booking was waiting for it) confirm the booking. If the time has been given to someone else in the meantime
 * the payment is refunded in full. Safe to run twice: the provider's payment id is unique in the ledger.
 */
export async function applyCapture(tenantDb: TenantDb, tenantId: string, accountId: string, captured: CapturedPayment, now: Date): Promise<CaptureResult> {
  const run = postgresRunner(tenantDb);
  const [order] = await run(sql`
    select id, appointment_id, amount_minor, currency, mode from payment_orders
    -- Only an order made on the account whose signature this event carried: another account's webhook secret never settles it.
    where tenant_id = ${tenantId} and account_id = ${accountId} and provider = ${captured.provider} and provider_order_id = ${captured.providerOrderId} for update`);
  if (!order) {
    await noteMismatch(run, tenantId, accountId, "missing_here", captured.providerPaymentId, captured.amountMinor, null);
    return "unknown_order";
  }
  const [existing] = await run(sql`select id from payments where tenant_id = ${tenantId} and provider = ${captured.provider} and provider_payment_id = ${captured.providerPaymentId}`);
  if (existing) return "already_recorded";
  // Never trust a payment that does not match what we asked for: the owner decides what to do with it.
  if (Number(order.amount_minor) !== captured.amountMinor || asString(order.currency).toUpperCase() !== captured.currency.toUpperCase()) {
    await noteMismatch(run, tenantId, accountId, "amount_differs", captured.providerPaymentId, captured.amountMinor, Number(order.amount_minor));
    return "amount_differs";
  }

  const appointmentId = asString(order.appointment_id);
  const [appointment] = await run(sql`
    select appointment.status::text as status, appointment.version, appointment.starts_at, appointment.price_minor, service.booking_mode
    from appointments as appointment join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
    where appointment.tenant_id = ${tenantId} and appointment.id = ${appointmentId} for update of appointment`);
  const [payment] = await run(sql`
    insert into payments (tenant_id, appointment_id, amount_minor, currency, method, provider, provider_payment_id, order_id, is_test)
    values (${tenantId}, ${appointmentId}, ${captured.amountMinor}, ${captured.currency.toUpperCase()}, ${captured.method}, ${captured.provider}, ${captured.providerPaymentId}, ${asString(order.id)}, ${order.mode === "test"})
    returning id`);
  const paymentId = asString(payment?.id);
  await run(sql`update payment_orders set status = 'paid', updated_at = now() where tenant_id = ${tenantId} and id = ${asString(order.id)}`);
  await run(sql`
    insert into audit_events (tenant_id, appointment_id, actor_type, action, outcome, metadata)
    values (${tenantId}, ${appointmentId}, 'provider', 'payment.captured', 'success', ${JSON.stringify({ paymentId, amountMinor: captured.amountMinor, currency: captured.currency, provider: captured.provider, test: order.mode === "test" })}::text::jsonb)`);
  if (!appointment) return "recorded";

  const status = asString(appointment.status);
  if (status !== "pending_payment" && status !== "expired" && status !== "cancelled" && status !== "entered_in_error") {
    // A balance paid later is recorded. Whatever goes past the visit's price (an old checkout paid in a second tab, or a
    // link paid after the desk took cash) goes back, so a customer is never charged twice.
    const over = await overpaidBy(run, tenantId, appointmentId, Number(appointment.price_minor ?? 0));
    if (over > 0) {
      await refundLateAndAlert(tenantDb, tenantId, appointmentId, asDate(appointment.starts_at), paymentId, Math.min(over, captured.amountMinor), "Paid more than the visit costs");
    }
    return "recorded";
  }
  if (status !== "pending_payment" && status !== "expired") {
    // A cancelled booking cannot be confirmed by a late payment, so the money goes back. Anything else (a balance paid later) is just recorded.
    if (status === "cancelled" || status === "entered_in_error") await refundLateAndAlert(tenantDb, tenantId, appointmentId, asDate(appointment.starts_at), paymentId, captured.amountMinor);
    return "recorded";
  }

  // Take the time back for this booking. If it was released and someone else booked it, the database refuses and the payment is refunded.
  let confirmed = true;
  try {
    await tenantDb.savepoint(async (savepoint) => {
      await savepoint`
        update resource_reservations set state = 'confirmed', hold_expires_at = null, updated_at = now()
        where tenant_id = ${tenantId} and appointment_id = ${appointmentId} and state in ('held', 'released')`;
    });
  } catch (error: unknown) {
    if (errorCode(error) !== EXCLUSION_VIOLATION) throw error;
    confirmed = false;
  }
  if (!confirmed) {
    await run(sql`
      insert into audit_events (tenant_id, appointment_id, actor_type, action, outcome, metadata)
      values (${tenantId}, ${appointmentId}, 'system', 'payment.late_refund', 'success', ${JSON.stringify({ paymentId, amountMinor: captured.amountMinor })}::text::jsonb)`);
    await refundLateAndAlert(tenantDb, tenantId, appointmentId, asDate(appointment.starts_at), paymentId, captured.amountMinor);
    return "recorded";
  }

  const next = asString(appointment.booking_mode) === "instant" ? "booked" : "requested";
  const [updated] = await run(sql`
    update appointments set status = ${next}::appointment_status, version = version + 1, updated_at = now()
    where tenant_id = ${tenantId} and id = ${appointmentId} returning version, starts_at`);
  const version = Number(updated?.version);
  await run(sql`
    insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
    values (${tenantId}, 'appointment', ${appointmentId}, 'appointment.created', ${JSON.stringify({ appointmentId, version })}::text::jsonb, ${`appointment.created:${appointmentId}:${version}`})
    on conflict (tenant_id, dedupe_key) do nothing`);
  try {
    await tenantDb.savepoint(async (savepoint) => {
      const inner = postgresRunner(savepoint);
      await alertStaff(inner, tenantId, {
        kind: next === "requested" ? "booking_request" : "new_booking", appointmentId, startsAt: updated?.starts_at ? asDate(updated.starts_at) : now,
        dedupeKey: `appointment.created:${appointmentId}`,
      });
      await alertStaff(inner, tenantId, { kind: "payment", appointmentId, startsAt: updated?.starts_at ? asDate(updated.starts_at) : now, dedupeKey: `payment:${paymentId}` });
      await planAppointment(inner, tenantId, appointmentId, { action: "appointment.created", version }, now);
    });
  } catch {
    // Alerts and workflow planning are not worth undoing a payment for; the sweep plans messages again later.
  }
  return "recorded";
}

/** How far what was taken for a visit, less refunds paid or on their way, goes past its price. A visit with no price is never over. */
async function overpaidBy(run: Runner, tenantId: string, appointmentId: string, priceMinor: number): Promise<number> {
  if (priceMinor <= 0) return 0;
  const [row] = await run(sql`
    select
      (select coalesce(sum(amount_minor), 0) from payments where tenant_id = ${tenantId} and appointment_id = ${appointmentId})
      - (select coalesce(sum(refund.amount_minor), 0) from payment_refunds as refund join payments as payment on payment.tenant_id = refund.tenant_id and payment.id = refund.payment_id
          where refund.tenant_id = ${tenantId} and payment.appointment_id = ${appointmentId})
      - (select coalesce(sum(request.amount_minor), 0) from refund_requests as request join payments as payment on payment.tenant_id = request.tenant_id and payment.id = request.payment_id
          where request.tenant_id = ${tenantId} and payment.appointment_id = ${appointmentId} and request.status = 'pending') as net`);
  return Math.max(0, Number(row?.net ?? 0) - priceMinor);
}

/** Pays a late payment back and tells staff, so the owner knows why money came in and went straight out. */
async function refundLateAndAlert(tenantDb: TenantDb, tenantId: string, appointmentId: string, startsAt: Date, paymentId: string, amountMinor: number, reason?: string): Promise<void> {
  await refundLate(postgresRunner(tenantDb), tenantId, paymentId, amountMinor, reason);
  try {
    await tenantDb.savepoint(async (savepoint) => {
      await alertStaff(postgresRunner(savepoint), tenantId, { kind: "needs_person", appointmentId, startsAt, dedupeKey: `payment:late:${paymentId}` });
    });
  } catch {
    // The refund is what matters; the alert is a courtesy.
  }
}

async function refundLate(run: Runner, tenantId: string, paymentId: string, amountMinor: number, reason = "Paid after the time was no longer held"): Promise<void> {
  await requestRefund(run, {
    tenantId, paymentId, amountMinor, reason, source: "late_payment", dedupeKey: `late:${paymentId}`,
  }, { clamp: true });
}
