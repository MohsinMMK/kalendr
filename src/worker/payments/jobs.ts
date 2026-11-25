import { sql } from "drizzle-orm";
import type postgres from "postgres";

import { releaseBookingOffers } from "../../server/offers/booking-offers";
import { queueRefundSend } from "../../server/payments/ledger";
import { postgresRunner } from "../../server/workflows/runner";
import { RECONCILE_EVENT } from "./reconcile";

export interface PaymentJobSummary {
  tenants: number;
  rows: number;
}

type PaymentJob = "hold_expiry" | "refunds" | "reconcile";

async function forEachPaymentTenant(
  database: postgres.Sql,
  job: PaymentJob,
  work: (tenantDb: postgres.TransactionSql, tenantId: string) => Promise<number>,
): Promise<PaymentJobSummary> {
  const rows = await database<{ tenant_id: string }[]>`select tenant_id from kalendr_payment_tenants(${job}) as tenant_id`;
  let count = 0;
  for (const { tenant_id: tenantId } of rows) {
    count += await database.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      return work(tenantDb, tenantId);
    }) as number;
  }
  return { tenants: rows.length, rows: count };
}

/**
 * Lets go of bookings that were held for payment and never paid. The time goes back on offer (the reservations are
 * released) and the booking is marked expired. A payment that arrives afterwards is handled by the capture: it re-takes
 * the time if it is still free, and is refunded if it is not.
 */
export function expireUnpaidHolds(database: postgres.Sql): Promise<PaymentJobSummary> {
  return forEachPaymentTenant(database, "hold_expiry", async (tenantDb, tenantId) => {
    const expired = await tenantDb<{ id: string }[]>`
      update appointments as appointment set status = 'expired', version = version + 1, updated_at = now()
      where appointment.tenant_id = ${tenantId} and appointment.status = 'pending_payment'
        and exists (
          select 1 from resource_reservations as reservation
          where reservation.tenant_id = appointment.tenant_id and reservation.appointment_id = appointment.id
            and (reservation.state = 'released' or reservation.hold_expires_at <= now()))
      returning appointment.id`;
    if (expired.length === 0) return 0;
    const ids = expired.map((row) => row.id);
    await tenantDb`update resource_reservations set state = 'released', updated_at = now() where tenant_id = ${tenantId} and state = 'held' and appointment_id in ${tenantDb(ids)}`;
    await tenantDb`update payment_orders set status = 'expired', updated_at = now() where tenant_id = ${tenantId} and status = 'created' and appointment_id in ${tenantDb(ids)}`;
    await tenantDb`
      insert into audit_events (tenant_id, appointment_id, actor_type, action, outcome, metadata)
      select ${tenantId}, id, 'system', 'payment.hold_expired', 'success', '{}'::jsonb from appointments where tenant_id = ${tenantId} and id in ${tenantDb(ids)}`;
    // A code taken for a booking that was never paid counts again (feature 25).
    const run = postgresRunner(tenantDb);
    for (const id of ids) await releaseBookingOffers(run, { tenantId, appointmentId: id, action: "appointment.status.expired" });
    return expired.length;
  });
}

/** Queues again any refund still waiting after ten minutes (a missed hand-off, a provider that was down). */
export function sweepStuckRefunds(database: postgres.Sql): Promise<PaymentJobSummary> {
  return forEachPaymentTenant(database, "refunds", async (tenantDb, tenantId) => {
    const stuck = await tenantDb<{ id: string }[]>`
      select id from refund_requests where tenant_id = ${tenantId} and status = 'pending' and created_at < now() - interval '10 minutes' order by created_at limit 100`;
    const bucket = Math.floor(Date.now() / 600_000);
    const run = postgresRunner(tenantDb);
    for (const row of stuck) await queueRefundSend(run, tenantId, row.id, bucket);
    return stuck.length;
  });
}

/** Once a night, asks each business's worker to compare the provider's payments for the day with the ledger. */
export function queueReconciliation(database: postgres.Sql): Promise<PaymentJobSummary> {
  return forEachPaymentTenant(database, "reconcile", async (tenantDb, tenantId) => {
    const run = postgresRunner(tenantDb);
    const day = new Date().toISOString().slice(0, 10);
    await run(sql`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
      values (${tenantId}, 'payment_account', ${tenantId}, ${RECONCILE_EVENT}, ${JSON.stringify({ day })}::text::jsonb, ${`payment.reconcile:${tenantId}:${day}`})
      on conflict (tenant_id, dedupe_key) do nothing`);
    return 1;
  });
}
