import { sql } from "drizzle-orm";

import { ratePercent, type ReportResult, type ReportTable } from "../../lib/reports";
import { appointmentWhere, bookingsHref, loadCurrency, num, rangeOf, type ReportContext } from "./common";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const CANCEL_REASONS: Record<string, string> = {
  cant_make_it: "Can't make it", booked_by_mistake: "Booked by mistake", found_another_time: "Found another time", feeling_better: "Feeling better",
  other: "Other reason", staff_preset: "Staff cancelled", reschedule_expired: "Reschedule not answered", spam: "Spam",
};

/** Share of visits that were due and ended as a no-show, split one way. `group` is a SQL expression; `labelOf` names a value. */
async function rateTable(context: ReportContext, key: string, title: string, label: string, group: ReturnType<typeof sql>, order: ReturnType<typeof sql>, labelOf: (value: string) => string): Promise<ReportTable> {
  const rows = await context.run(sql`
    select ${group} as bucket,
      count(*) filter (where a.status = 'no_show') as no_shows,
      count(*) as due
    from appointments a
    join locations l on l.tenant_id = a.tenant_id and l.id = a.location_id
    join services s on s.tenant_id = a.tenant_id and s.id = a.service_id
    where ${appointmentWhere(context.scope, rangeOf(context.params))} and a.status in ('completed', 'no_show')
    group by 1 order by ${order}`);
  return {
    key, title, note: "No-show rate: no-shows ÷ visits that were due.",
    columns: [{ key: "name", label }, { key: "due", label: "Visits due", format: "count" }, { key: "no_shows", label: "No-shows", format: "count" }, { key: "rate", label: "No-show rate", format: "percent" }],
    rows: rows.map((row) => ({ name: labelOf(String(row.bucket)), due: num(row.due), no_shows: num(row.no_shows), rate: ratePercent(num(row.no_shows), num(row.due)) })),
  };
}

export async function noShowsReport(context: ReportContext): Promise<ReportResult> {
  const { run, scope } = context;
  const range = rangeOf(context.params);
  const [totals] = await run(sql`
    select count(*) filter (where a.status = 'no_show') as no_shows, count(*) filter (where a.status in ('completed', 'no_show')) as due,
      count(*) filter (where a.status = 'cancelled') as cancelled, count(*) filter (where a.status in ('booked','checked_in','completed','no_show','cancelled')) as booked
    from appointments a join locations l on l.tenant_id = a.tenant_id and l.id = a.location_id
    where ${appointmentWhere(scope, range)}`);
  const cancelReasons = await run(sql`
    select coalesce(a.cancel_reason_code, 'other') as reason, count(*) as total
    from appointments a join locations l on l.tenant_id = a.tenant_id and l.id = a.location_id
    where ${appointmentWhere(scope, range)} and a.status = 'cancelled' group by 1 order by total desc`);

  const tables: ReportTable[] = [
    await rateTable(context, "by_service", "By service", "Service", sql`s.name`, sql`3 desc, 1`, (value) => value),
    await rateTable(context, "by_day", "By day of the week", "Day", sql`extract(isodow from a.starts_at at time zone l.timezone)::int`, sql`1`, (value) => WEEKDAYS[Number(value) - 1] ?? value),
    await rateTable(context, "by_lead", "By how far ahead it was booked", "Booked", sql`case when a.created_at >= a.starts_at - interval '1 day' then 0 when a.created_at >= a.starts_at - interval '7 days' then 1 when a.created_at >= a.starts_at - interval '30 days' then 2 else 3 end`, sql`1`,
      (value) => ["Within a day", "1 to 7 days ahead", "8 to 30 days ahead", "More than 30 days ahead"][Number(value)] ?? value),
    await rateTable(context, "by_reminder", "With and without a reminder", "Reminder", sql`case when a.reminder_status = 'delivered' then 1 else 0 end`, sql`1 desc`, (value) => (value === "1" ? "Reminder delivered" : "No reminder delivered")),
    await rateTable(context, "by_deposit", "With and without a payment", "Payment", sql`case when exists (select 1 from payments p where p.tenant_id = a.tenant_id and p.appointment_id = a.id and not p.is_test and p.created_at <= a.starts_at) then 1 else 0 end`, sql`1 desc`, (value) => (value === "1" ? "Paid before the visit" : "Nothing paid before the visit")),
    { key: "cancel_reasons", title: "Why bookings were cancelled", columns: [{ key: "name", label: "Reason" }, { key: "total", label: "Cancellations", format: "count" }],
      rows: cancelReasons.map((row) => ({ name: CANCEL_REASONS[String(row.reason)] ?? "Other reason", total: num(row.total) })) },
  ];
  return {
    report: "noshows", range, currency: await loadCurrency(run, scope.tenantId), scopedToPerson: Boolean(scope.practitionerId),
    metrics: [
      { key: "no_show_rate", label: "No-show rate", value: ratePercent(num(totals?.no_shows), num(totals?.due)), format: "percent", formula: "No-show rate: no-shows ÷ visits that were due (completed plus no-show).", href: bookingsHref(context, "past", { statuses: "no_show" }) },
      { key: "no_shows", label: "No-shows", value: num(totals?.no_shows), format: "count", formula: "No-shows: bookings staff marked as a no-show in the period.", href: bookingsHref(context, "past", { statuses: "no_show" }) },
      { key: "cancel_rate", label: "Cancellation rate", value: ratePercent(num(totals?.cancelled), num(totals?.booked)), format: "percent", formula: "Cancellation rate: cancelled bookings ÷ all bookings made for the period, cancelled ones included.", href: bookingsHref(context, "cancelled") },
    ],
    charts: [], tables,
  };
}
