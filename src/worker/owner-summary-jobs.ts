import type postgres from "postgres";

import { localParts } from "../lib/quiet-hours";
import {
  effectiveFrequency,
  OWNER_SUMMARY_EVENT,
  ownerSummarySchema,
  previousDay,
  summaryPeriod,
  type OwnerSummary,
  type SummaryMetrics,
} from "../lib/owner-summary";
import { forEachTenant, type JobSummary } from "./jobs";

/**
 * The owner's weekly or monthly summary (Cal.com parity wave, lane C), checked every hour. For each active owner whose choice
 * is weekly or monthly and whose period has not gone out, it counts the period and the one before it and queues one outbox
 * row for the worker to email, next to the morning digest. The period's first day is stamped on the person, so a period is never
 * sent twice, and the outbox key repeats the guard. Owners who chose "off" are never listed. Only counts go in the row: no names,
 * no contact details, no notes.
 */
interface Owner {
  id: string;
  role: string;
  summary_frequency: string | null;
  summary_sent_for: string | null;
}

export function sendOwnerSummaries(database: postgres.Sql, now: () => Date = () => new Date()): Promise<JobSummary> {
  return forEachTenant(database, "owner_summary", async (tenantDb, tenantId) => {
    const at = now();
    const [tenant] = await tenantDb<{ timezone: string; currency: string }[]>`select timezone, currency from tenants where id = ${tenantId}`;
    if (!tenant) return 0;
    const { day } = localParts(at, tenant.timezone);
    const owners = await tenantDb<Owner[]>`
      select id, role, summary_frequency, summary_sent_for::text as summary_sent_for
      from memberships where tenant_id = ${tenantId} and is_active and role = 'owner' for update`;
    let queued = 0;
    for (const owner of owners) {
      const frequency = effectiveFrequency(owner.summary_frequency, owner.role);
      if (frequency === "off") continue;
      const period = summaryPeriod(day, frequency);
      if (!period || owner.summary_sent_for === period.start) continue;

      const current = await metrics(tenantDb, tenantId, tenant.timezone, tenant.currency, period.start, period.end);
      const previous = await metrics(tenantDb, tenantId, tenant.timezone, tenant.currency, period.previousStart, period.start);
      // Stamped either way: a period with nothing in it has still been looked at.
      await tenantDb`update memberships set summary_sent_for = ${period.start}::date where tenant_id = ${tenantId} and id = ${owner.id}`;
      if (isEmpty(current) && isEmpty(previous)) continue;
      const payload: OwnerSummary = ownerSummarySchema.parse({
        membershipId: owner.id, frequency, start: period.start, last: previousDay(period.end), currency: tenant.currency, current, previous,
      });
      await tenantDb`
        insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
        values (${tenantId}, 'owner_summary', ${owner.id}, ${OWNER_SUMMARY_EVENT}, ${tenantDb.json(payload)},
          ${`staff.summary:${owner.id}:${period.start}`})
        on conflict (tenant_id, dedupe_key) do nothing`;
      queued += 1;
    }
    return queued;
  });
}

function isEmpty(value: SummaryMetrics): boolean {
  return value.bookings === 0 && value.cancellations === 0 && value.noShows === 0 && value.newCustomers === 0 && value.revenueMinor === 0;
}

/** Counts for the local days from `from` up to (not including) `to`. Test and sample rows never count. */
async function metrics(tenantDb: postgres.TransactionSql, tenantId: string, timeZone: string, currency: string, from: string, to: string): Promise<SummaryMetrics> {
  const start = tenantDb`(${from}::date)::timestamp at time zone ${timeZone}`;
  const end = tenantDb`(${to}::date)::timestamp at time zone ${timeZone}`;
  const [visits] = await tenantDb<{ bookings: number; no_shows: number }[]>`
    select
      count(*) filter (where status in ('booked', 'checked_in', 'completed'))::int as bookings,
      count(*) filter (where status = 'no_show')::int as no_shows
    from appointments
    where tenant_id = ${tenantId} and not is_test and starts_at >= ${start} and starts_at < ${end}`;
  const [cancelled] = await tenantDb<{ total: number }[]>`
    select count(*)::int as total from appointments
    where tenant_id = ${tenantId} and not is_test and status = 'cancelled' and cancelled_at >= ${start} and cancelled_at < ${end}`;
  const [customers] = await tenantDb<{ total: number }[]>`
    select count(*)::int as total from patients
    where tenant_id = ${tenantId} and not is_test and merged_into_id is null and erased_at is null
      and created_at >= ${start} and created_at < ${end}`;
  const [taken] = await tenantDb<{ total: string }[]>`
    select coalesce(sum(amount_minor), 0)::text as total from payments
    where tenant_id = ${tenantId} and not is_test and currency = ${currency} and created_at >= ${start} and created_at < ${end}`;
  // A refund has no currency of its own; it follows the payment it refunds.
  const [refunded] = await tenantDb<{ total: string }[]>`
    select coalesce(sum(r.amount_minor), 0)::text as total from payment_refunds r
    join payments p on p.tenant_id = r.tenant_id and p.id = r.payment_id
    where r.tenant_id = ${tenantId} and not r.is_test and p.currency = ${currency} and r.created_at >= ${start} and r.created_at < ${end}`;
  return {
    bookings: visits?.bookings ?? 0,
    cancellations: cancelled?.total ?? 0,
    noShows: visits?.no_shows ?? 0,
    newCustomers: customers?.total ?? 0,
    revenueMinor: Number(taken?.total ?? 0) - Number(refunded?.total ?? 0),
  };
}
