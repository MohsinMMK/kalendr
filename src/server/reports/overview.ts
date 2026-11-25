import { sql } from "drizzle-orm";

import { previousRange, ratePercent, type ReportResult } from "../../lib/reports";
import {
  appointmentWhere, bookingsHref, BOOKED_STATUSES, DUE_STATUSES, loadCurrency, num, PAYMENT_FROM, paymentWhere, rangeOf,
  type Range, type ReportContext,
} from "./common";

interface Totals {
  bookings: number;
  due: number;
  noShows: number;
  newCustomers: number;
  revenue: number;
  refunds: number;
}

/** One period's headline figures. Money is skipped for people who may not see it. */
export async function overviewTotals(context: ReportContext, range: Range): Promise<Totals> {
  const { run, scope } = context;
  const [counts] = await run(sql`
    select
      count(*) filter (where a.status in ${BOOKED_STATUSES}) as bookings,
      count(*) filter (where a.status in ${DUE_STATUSES}) as due,
      count(*) filter (where a.status = 'no_show') as no_shows
    from appointments a join locations l on l.tenant_id = a.tenant_id and l.id = a.location_id
    where ${appointmentWhere(scope, range)}`);
  // New customers: people whose first booking that was not cancelled falls in the range (and inside the scope).
  const [fresh] = await run(sql`
    select count(distinct a.patient_id) as total
    from appointments a join locations l on l.tenant_id = a.tenant_id and l.id = a.location_id
    where ${appointmentWhere(scope, range)} and a.status in ${BOOKED_STATUSES}
      and not exists (
        select 1 from appointments earlier
        where earlier.tenant_id = a.tenant_id and earlier.patient_id = a.patient_id and earlier.starts_at < a.starts_at
          and earlier.status in ${BOOKED_STATUSES} and not earlier.is_test and not earlier.is_sample)`);
  let revenue = 0;
  let refunds = 0;
  if (scope.canSeeRevenue) {
    const [paid] = await run(sql`select coalesce(sum(p.amount_minor), 0) as total from ${PAYMENT_FROM} where ${paymentWhere(scope, range)}`);
    const [back] = await run(sql`
      select coalesce(sum(r.amount_minor), 0) as total
      from payment_refunds r
      join payments p on p.tenant_id = r.tenant_id and p.id = r.payment_id
      left join appointments a on a.tenant_id = p.tenant_id and a.id = p.appointment_id
      join locations l on l.tenant_id = p.tenant_id and l.id = coalesce(a.location_id, p.location_id)
      where ${paymentWhere(scope, range, sql`r.created_at`)} and not r.is_test`);
    revenue = num(paid?.total);
    refunds = num(back?.total);
  }
  return { bookings: num(counts?.bookings), due: num(counts?.due), noShows: num(counts?.no_shows), newCustomers: num(fresh?.total), revenue, refunds };
}

export async function overviewReport(context: ReportContext): Promise<ReportResult> {
  const range = rangeOf(context.params);
  const [current, before] = await Promise.all([overviewTotals(context, range), overviewTotals(context, previousRange(range))]);
  const net = (totals: Totals) => totals.revenue - totals.refunds;
  const noShowRate = (totals: Totals) => ratePercent(totals.noShows, totals.due);
  const metrics: ReportResult["metrics"] = [
    { key: "bookings", label: "Bookings", value: current.bookings, previous: before.bookings, format: "count",
      formula: "Bookings: appointments in the period that were not cancelled, declined or expired.", href: bookingsHref(context, "past") },
  ];
  if (context.scope.canSeeRevenue) {
    metrics.push({ key: "revenue", label: "Revenue", value: net(current), previous: net(before), format: "money",
      formula: "Revenue: payments received in the period, less refunds given. Test payments are left out." });
  }
  metrics.push(
    { key: "new_customers", label: "New customers", value: current.newCustomers, previous: before.newCustomers, format: "count",
      formula: "New customers: people whose first booking was in the period." },
    { key: "no_show_rate", label: "No-show rate", value: noShowRate(current), previous: noShowRate(before), format: "percent",
      formula: "No-show rate: no-shows ÷ visits that were due (completed plus no-show).", href: bookingsHref(context, "past", { statuses: "no_show" }) },
  );
  return {
    report: "overview", range, currency: await loadCurrency(context.run, context.scope.tenantId), scopedToPerson: Boolean(context.scope.practitionerId),
    metrics, charts: [], tables: [],
  };
}
