import { sql } from "drizzle-orm";

import { loadAccountById, openCredentials } from "../../server/payments/credentials";
import { providerFor, type ProviderEnvironment } from "../../server/payments/index";
import { recordRefundPaid } from "../../server/payments/ledger";
import { ProviderError } from "../../server/payments/types";
import { postgresDataKeyStore } from "../../server/keys/postgres-store";
import { loadDataKeys } from "../../server/keys/ring";
import { asDate, asNumber, asString, postgresRunner } from "../../server/workflows/runner";
import type { EventHandler, TenantDb } from "../handlers/types";
import { alertStaff } from "./alerts";

const refundPayloadKey = "refundRequestId";

/**
 * Sends one waiting refund to the provider and, when the provider has paid it out, writes the ledger row.
 * The provider is given the request's own id as its idempotency key, so a retry after a timeout (or after the
 * transaction rolled back following a successful call) gets the same refund back instead of making a second one.
 */
export function refundProcessHandler(environment: ProviderEnvironment): EventHandler {
  return async (tenantDb, event) => {
    const requestId = typeof (event.payload as Record<string, unknown> | null)?.[refundPayloadKey] === "string" ? String((event.payload as Record<string, unknown>)[refundPayloadKey]) : null;
    if (!requestId) return { outcome: "dead", code: "invalid_refund_event" };
    const run = postgresRunner(tenantDb);
    const [request] = await run(sql`
      select id, payment_id, amount_minor, reason, status, provider_refund_id from refund_requests
      where tenant_id = ${event.tenantId} and id = ${requestId} for update`);
    if (!request || asString(request.status) !== "pending") return "delivered";
    const [payment] = await run(sql`
      select id, appointment_id, provider, provider_payment_id, currency, is_test, order_id from payments where tenant_id = ${event.tenantId} and id = ${asString(request.payment_id)}`);
    if (!payment || !payment.provider_payment_id) return fail(tenantDb, event.tenantId, requestId, "payment_not_online");
    const [order] = await run(sql`select account_id from payment_orders where tenant_id = ${event.tenantId} and id = ${asString(payment.order_id)}`);
    const account = order ? await loadAccountById(run, event.tenantId, asString(order.account_id)) : null;
    if (!account || account.status !== "active") return fail(tenantDb, event.tenantId, requestId, "account_disconnected");

    await loadDataKeys(postgresDataKeyStore(tenantDb), event.tenantId);
    const credentials = account.provider === "stripe"
      ? { keyId: account.keyId, keySecret: "", webhookSecret: "" }
      : openCredentials(account);
    const amountMinor = asNumber(request.amount_minor);
    let result;
    try {
      result = await providerFor(account.provider, environment).refund(credentials, {
        providerPaymentId: asString(payment.provider_payment_id), amountMinor, currency: asString(payment.currency), idempotencyKey: requestId,
      });
    } catch (error: unknown) {
      if (error instanceof ProviderError && error.retryable) return { outcome: "retry", code: error.code };
      return fail(tenantDb, event.tenantId, requestId, error instanceof ProviderError ? error.code : "refund_failed");
    }
    if (result.status === "processed") {
      await recordRefundPaid(run, {
        tenantId: event.tenantId, paymentId: asString(payment.id), amountMinor, providerRefundId: result.providerRefundId, requestId,
        reason: asString(request.reason), isTest: payment.is_test === true,
      });
      await auditRefund(tenantDb, event.tenantId, asString(payment.appointment_id), asString(payment.id), requestId, amountMinor);
    } else {
      // The provider will confirm it later with a webhook; until then the request stays open and counts against the payment.
      await run(sql`update refund_requests set provider_refund_id = ${result.providerRefundId}, updated_at = now() where tenant_id = ${event.tenantId} and id = ${requestId}`);
      // The provider's webhook may already have written the ledger row for this refund: then the request is done now.
      const [paid] = await run(sql`select id from payment_refunds where tenant_id = ${event.tenantId} and provider_refund_id = ${result.providerRefundId}`);
      if (paid) {
        await run(sql`update refund_requests set status = 'done', updated_at = now() where tenant_id = ${event.tenantId} and id = ${requestId} and status = 'pending'`);
      }
    }
    return "delivered";
  };
}

async function fail(tenantDb: TenantDb, tenantId: string, requestId: string, code: string): Promise<"delivered"> {
  const run = postgresRunner(tenantDb);
  await run(sql`update refund_requests set status = 'failed', failure_code = ${code.slice(0, 60)}, updated_at = now() where tenant_id = ${tenantId} and id = ${requestId} and status = 'pending'`);
  await run(sql`
    insert into audit_events (tenant_id, actor_type, action, outcome, metadata)
    values (${tenantId}, 'system', 'payment.refund_failed', 'failure', ${JSON.stringify({ refundRequestId: requestId, code })}::text::jsonb)`);
  // The customer is owed this money and nothing else will say so: a person has to look (the reason is on the audit trail).
  const [visit] = await run(sql`
    select appointment.id, appointment.starts_at from refund_requests as request
    join payments as payment on payment.tenant_id = request.tenant_id and payment.id = request.payment_id
    join appointments as appointment on appointment.tenant_id = payment.tenant_id and appointment.id = payment.appointment_id
    where request.tenant_id = ${tenantId} and request.id = ${requestId}`);
  if (visit) {
    try {
      await tenantDb.savepoint(async (savepoint) => {
        await alertStaff(postgresRunner(savepoint), tenantId, { kind: "needs_person", appointmentId: asString(visit.id), startsAt: asDate(visit.starts_at), dedupeKey: `refund_failed:${requestId}` });
      });
    } catch {
      // The failed request and the audit row already say it.
    }
  }
  return "delivered";
}

async function auditRefund(tenantDb: TenantDb, tenantId: string, appointmentId: string, paymentId: string, requestId: string, amountMinor: number): Promise<void> {
  await postgresRunner(tenantDb)(sql`
    insert into audit_events (tenant_id, appointment_id, actor_type, action, outcome, metadata)
    values (${tenantId}, ${appointmentId}, 'provider', 'payment.refunded', 'success', ${JSON.stringify({ paymentId, refundRequestId: requestId, amountMinor })}::text::jsonb)`);
}

/**
 * The provider says a refund was paid out. Closes our request, or, for a refund made in the provider's own dashboard,
 * writes the ledger row so the books match. A refund bigger than what is left on the payment goes to the owner's list instead.
 */
export async function applyRefundProcessed(tenantDb: TenantDb, tenantId: string, accountId: string, event: { provider: string; providerPaymentId: string; providerRefundId: string; amountMinor: number }, lastTry = true): Promise<"done" | "not_yet"> {
  const run = postgresRunner(tenantDb);
  const [payment] = await run(sql`
    select id, amount_minor, is_test, appointment_id from payments
    where tenant_id = ${tenantId} and provider = ${event.provider} and provider_payment_id = ${event.providerPaymentId} for update`);
  // Providers do not promise order: the capture may not be recorded yet. Try again shortly rather than lose the refund.
  if (!payment) return "not_yet";
  const paymentId = asString(payment.id);
  const [byRequest] = await run(sql`select id, reason from refund_requests where tenant_id = ${tenantId} and payment_id = ${paymentId} and provider_refund_id = ${event.providerRefundId}`);
  if (byRequest) {
    await recordRefundPaid(run, { tenantId, paymentId, amountMinor: event.amountMinor, providerRefundId: event.providerRefundId, requestId: asString(byRequest.id), reason: asString(byRequest.reason), isTest: payment.is_test === true });
    return "done";
  }
  const [known] = await run(sql`select id from payment_refunds where tenant_id = ${tenantId} and provider_refund_id = ${event.providerRefundId}`);
  if (known) return "done";
  // One of our own refunds is with the provider and has not been told its id yet: this is very likely that refund, so wait
  // for the worker to note the id instead of booking it as a second, dashboard refund and leaving our request open forever.
  const [inFlight] = await run(sql`
    select id from refund_requests where tenant_id = ${tenantId} and payment_id = ${paymentId} and status = 'pending' and provider_refund_id is null limit 1`);
  // On the last try it is booked as a dashboard refund after all, so the books never miss money that left.
  if (inFlight && !lastTry) return "not_yet";
  const [ledger] = await run(sql`select coalesce(sum(amount_minor), 0) as total from payment_refunds where tenant_id = ${tenantId} and payment_id = ${paymentId}`);
  const left = asNumber(payment.amount_minor) - asNumber(ledger?.total);
  if (event.amountMinor > left) {
    await run(sql`
      insert into payment_mismatches (tenant_id, account_id, day, kind, provider_payment_id, provider_amount_minor, ledger_amount_minor)
      values (${tenantId}, ${accountId}, current_date, 'amount_differs', ${event.providerPaymentId}, ${event.amountMinor}, ${left}) on conflict do nothing`);
    return "done";
  }
  await recordRefundPaid(run, { tenantId, paymentId, amountMinor: event.amountMinor, providerRefundId: event.providerRefundId, requestId: null, reason: "Refunded in the payment provider's dashboard", isTest: payment.is_test === true });
  return "done";
}

