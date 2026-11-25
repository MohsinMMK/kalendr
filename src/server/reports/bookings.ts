import { sql } from "drizzle-orm";

import { bookingSourceLabels } from "../../lib/bookings-list";
import type { ReportChart, ReportResult, ReportTable } from "../../lib/reports";
import { appointmentWhere, bookingsHref, BOOKED_STATUSES, loadCurrency, num, rangeOf, type ReportContext } from "./common";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const LEAD_BUCKETS = ["Same day", "1 to 2 days", "3 to 7 days", "8 to 30 days", "More than 30 days"] as const;

/** Appointments that count as bookings, with the local day and hour each one starts in. */
const base = (context: ReportContext) => sql`
  from appointments a
  join locations l on l.tenant_id = a.tenant_id and l.id = a.location_id
  join services s on s.tenant_id = a.tenant_id and s.id = a.service_id
  join practitioners pr on pr.tenant_id = a.tenant_id and pr.id = a.practitioner_id
  where ${appointmentWhere(context.scope, rangeOf(context.params))} and a.status in ${BOOKED_STATUSES}`;

export async function bookingsReport(context: ReportContext): Promise<ReportResult> {
  const { run } = context;
  const [byDay, byService, byStaff, bySource, lead, heat] = await Promise.all([
    run(sql`select to_char(a.starts_at at time zone l.timezone, 'YYYY-MM-DD') as day, count(*) as total ${base(context)} group by 1 order by 1`),
    run(sql`select s.id, s.name, count(*) as total ${base(context)} group by s.id, s.name order by total desc, s.name`),
    run(sql`select pr.id, pr.name, count(*) as total ${base(context)} group by pr.id, pr.name order by total desc, pr.name`),
    run(sql`select a.booking_source::text as source, count(*) as total ${base(context)} group by 1 order by total desc`),
    run(sql`
      select case
          when a.created_at >= a.starts_at - interval '1 day' then 0
          when a.created_at >= a.starts_at - interval '3 days' then 1
          when a.created_at >= a.starts_at - interval '8 days' then 2
          when a.created_at >= a.starts_at - interval '31 days' then 3
          else 4 end as bucket, count(*) as total
      ${base(context)} group by 1 order by 1`),
    run(sql`
      select extract(isodow from a.starts_at at time zone l.timezone)::int as dow, extract(hour from a.starts_at at time zone l.timezone)::int as hour, count(*) as total
      ${base(context)} group by 1, 2`),
  ]);
  const total = byDay.reduce((sum, row) => sum + num(row.total), 0);

  const charts: ReportChart[] = [
    { key: "by_day", title: "Bookings by day", kind: "bar", xKey: "day", series: [{ key: "bookings", label: "Bookings" }], rows: byDay.map((row) => ({ day: String(row.day), bookings: num(row.total) })) },
    { key: "heat", title: "Busiest hours", kind: "heat", xKey: "weekday", series: Array.from({ length: 24 }, (_, hour) => ({ key: `h${hour}`, label: `${String(hour).padStart(2, "0")}:00` })),
      rows: WEEKDAYS.map((weekday, index) => {
        const row: Record<string, string | number> = { weekday };
        for (let hour = 0; hour < 24; hour += 1) row[`h${hour}`] = heat.filter((cell) => num(cell.dow) === index + 1 && num(cell.hour) === hour).reduce((sum, cell) => sum + num(cell.total), 0);
        return row;
      }) },
    { key: "lead_time", title: "How far ahead people book", kind: "bar", xKey: "lead", series: [{ key: "bookings", label: "Bookings" }],
      rows: LEAD_BUCKETS.map((lead_, index) => ({ lead: lead_, bookings: num(lead.find((row) => num(row.bucket) === index)?.total) })) },
  ];
  const tables: ReportTable[] = [
    { key: "by_service", title: "By service", columns: [{ key: "name", label: "Service" }, { key: "total", label: "Bookings", format: "count" }, { key: "share", label: "Share", format: "percent" }],
      hrefKey: "href", rows: byService.map((row) => ({ name: String(row.name), total: num(row.total), share: total ? Math.round((num(row.total) / total) * 1000) / 10 : 0, href: bookingsHref(context, "past", { serviceIds: String(row.id) }) })) },
    { key: "by_staff", title: "By staff member", columns: [{ key: "name", label: "Staff member" }, { key: "total", label: "Bookings", format: "count" }, { key: "share", label: "Share", format: "percent" }],
      hrefKey: "href", rows: byStaff.map((row) => ({ name: String(row.name), total: num(row.total), share: total ? Math.round((num(row.total) / total) * 1000) / 10 : 0, href: bookingsHref({ ...context, scope: { ...context.scope, practitionerId: String(row.id) } }, "past") })) },
    { key: "by_source", title: "By source", columns: [{ key: "name", label: "Source" }, { key: "total", label: "Bookings", format: "count" }, { key: "share", label: "Share", format: "percent" }],
      hrefKey: "href", rows: bySource.map((row) => ({ name: bookingSourceLabels[String(row.source) as keyof typeof bookingSourceLabels] ?? String(row.source), total: num(row.total), share: total ? Math.round((num(row.total) / total) * 1000) / 10 : 0, href: bookingsHref(context, "past", { sources: String(row.source) }) })) },
  ];
  return {
    report: "bookings", range: rangeOf(context.params), currency: await loadCurrency(run, context.scope.tenantId), scopedToPerson: Boolean(context.scope.practitionerId),
    metrics: [{ key: "bookings", label: "Bookings", value: total, format: "count", formula: "Bookings: appointments in the period that were not cancelled, declined or expired.", href: bookingsHref(context, "past") }],
    charts, tables,
  };
}
