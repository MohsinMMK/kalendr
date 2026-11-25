import { sql } from "drizzle-orm";

import { ratePercent, type ReportMetric, type ReportResult } from "../../lib/reports";
import { appointmentWhere, BOOKED_STATUSES, loadCurrency, num, rangeOf, type ReportContext } from "./common";

const WINDOWS = [30, 60, 90] as const;

/** New against returning, how many come back within 30, 60 and 90 days, and who visits most. */
export async function customersReport(context: ReportContext): Promise<ReportResult> {
  const { run, scope, now } = context;
  const range = rangeOf(context.params);
  const [split] = await run(sql`
    select count(*) filter (where is_new) as new_customers, count(*) filter (where not is_new) as returning_customers
    from (
      select a.patient_id, bool_or(not exists (
        select 1 from appointments earlier
        where earlier.tenant_id = a.tenant_id and earlier.patient_id = a.patient_id and earlier.starts_at < a.starts_at
          and earlier.status in ${BOOKED_STATUSES} and not earlier.is_test and not earlier.is_sample)) as is_new
      from appointments a join locations l on l.tenant_id = a.tenant_id and l.id = a.location_id
      where ${appointmentWhere(scope, range)} and a.status in ${BOOKED_STATUSES}
      group by a.patient_id) visitors`);

  // The cohort: people whose first completed visit was in the period. A window only counts people whose window has fully passed.
  const [cohort] = await run(sql`
    select
      ${sql.join(WINDOWS.map((days) => sql`
        count(*) filter (where first.ends_at <= ${now.toISOString()}::timestamptz - (${days} * interval '1 day')) as eligible_${sql.raw(String(days))},
        count(*) filter (where first.ends_at <= ${now.toISOString()}::timestamptz - (${days} * interval '1 day') and first.next_start <= first.ends_at + (${days} * interval '1 day')) as rebooked_${sql.raw(String(days))}`), sql`,`)}
    from (
      select a.ends_at, (
        select min(next.starts_at) from appointments next
        where next.tenant_id = a.tenant_id and next.patient_id = a.patient_id and next.id <> a.id
          and next.status in ('booked', 'checked_in', 'completed') and not next.is_test and not next.is_sample and next.starts_at >= a.ends_at) as next_start
      from appointments a join locations l on l.tenant_id = a.tenant_id and l.id = a.location_id
      where ${appointmentWhere(scope, range)} and a.status = 'completed'
        and not exists (
          select 1 from appointments earlier
          where earlier.tenant_id = a.tenant_id and earlier.patient_id = a.patient_id and earlier.status = 'completed'
            and not earlier.is_test and not earlier.is_sample and earlier.starts_at < a.starts_at)) first`);
  const rebooking: ReportMetric[] = WINDOWS.map((days) => ({
    key: `rebook_${days}`, label: `Rebooked within ${days} days`, value: ratePercent(num(cohort?.[`rebooked_${days}`]), num(cohort?.[`eligible_${days}`])), format: "percent",
    formula: `Rebooking rate: of people whose first visit finished at least ${days} days ago, the share who booked another within ${days} days.`,
  }));

  const top = await run(sql`
    select pat.id, pat.first_name, pat.last_name, count(*) as visits,
      ${scope.canSeeRevenue ? sql`coalesce(sum((select sum(p.amount_minor) from payments p where p.tenant_id = a.tenant_id and p.appointment_id = a.id and not p.is_test)), 0)` : sql`0`} as spent
    from appointments a
    join locations l on l.tenant_id = a.tenant_id and l.id = a.location_id
    join patients pat on pat.tenant_id = a.tenant_id and pat.id = a.patient_id
    where ${appointmentWhere(scope, range)} and a.status in ('completed', 'checked_in', 'booked')
    group by pat.id, pat.first_name, pat.last_name
    order by ${scope.canSeeRevenue ? sql`spent desc, visits desc` : sql`visits desc`}, pat.last_name, pat.first_name limit 10`);

  const fresh = num(split?.new_customers);
  const back = num(split?.returning_customers);
  return {
    report: "customers", range, currency: await loadCurrency(run, scope.tenantId), scopedToPerson: Boolean(scope.practitionerId),
    metrics: [
      { key: "new_customers", label: "New customers", value: fresh, format: "count", formula: "New customers: people whose first booking was in the period." },
      { key: "returning_customers", label: "Returning customers", value: back, format: "count", formula: "Returning customers: people with a booking in the period who had booked before." },
      ...rebooking,
    ],
    charts: [{ key: "new_returning", title: "New and returning", kind: "bar", xKey: "kind", series: [{ key: "customers", label: "Customers" }], rows: [{ kind: "New", customers: fresh }, { kind: "Returning", customers: back }] }],
    tables: [{
      key: "top", title: "Top customers", note: scope.canSeeRevenue ? "Ranked by what they paid, then visits." : "Ranked by visits.",
      columns: [{ key: "name", label: "Customer" }, { key: "visits", label: "Visits", format: "count" }, ...(scope.canSeeRevenue ? [{ key: "spent", label: "Paid", format: "money" as const }] : [])],
      hrefKey: "href", rows: top.map((row) => ({ name: `${row.first_name} ${row.last_name}`.trim(), visits: num(row.visits), spent: num(row.spent), href: `/patients?patient=${encodeURIComponent(String(row.id))}` })),
    }],
  };
}
