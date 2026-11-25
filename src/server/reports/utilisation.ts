import { sql } from "drizzle-orm";

import { utilisationPercent, type ReportResult } from "../../lib/reports";
import { appointmentWhere, bookingsHref, limitedLocations, loadCurrency, num, OCCUPIED_STATUSES, rangeOf, type ReportContext } from "./common";

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Booked hours against available hours, per staff member. Available hours are each day's working hours from the person's
 * default schedule (breaks are separate ranges, so they are not counted). Time off and one-off changes are not taken away.
 */
export async function utilisationReport(context: ReportContext): Promise<ReportResult> {
  const { run, scope, params } = context;
  const range = rangeOf(params);
  const booked = await run(sql`
    select a.practitioner_id, sum(extract(epoch from (a.ends_at - a.starts_at))) / 3600.0 as hours
    from appointments a join locations l on l.tenant_id = a.tenant_id and l.id = a.location_id
    where ${appointmentWhere(scope, range)} and a.status in ${OCCUPIED_STATUSES}
    group by 1`);
  const available = await run(sql`
    select rule.practitioner_id, sum(extract(epoch from (rule.ends_at_local - rule.starts_at_local))) / 3600.0 as hours
    from generate_series(${range.from}::date, ${range.to}::date, interval '1 day') as day
    join availability_rules rule on rule.tenant_id = ${scope.tenantId} and rule.is_active
      and rule.day_of_week = extract(isodow from day)::int
      and rule.valid_from <= day::date and (rule.valid_through is null or rule.valid_through >= day::date)
    join availability_schedules schedule on schedule.tenant_id = rule.tenant_id and schedule.id = rule.schedule_id and schedule.is_default
    where true
      ${scope.locationId ? sql`and rule.location_id = ${scope.locationId}` : sql``}
      ${limitedLocations(scope, sql`rule.location_id`)}
      ${scope.practitionerId ? sql`and rule.practitioner_id = ${scope.practitionerId}` : sql``}
    group by 1`);
  const people = await run(sql`select id, name from practitioners where tenant_id = ${scope.tenantId} ${scope.practitionerId ? sql`and id = ${scope.practitionerId}` : sql``} order by name`);

  const rows = people.map((person) => {
    const bookedHours = num(booked.find((row) => row.practitioner_id === person.id)?.hours);
    const availableHours = num(available.find((row) => row.practitioner_id === person.id)?.hours);
    return { id: String(person.id), name: String(person.name), booked: round1(bookedHours), available: round1(availableHours), rate: utilisationPercent(bookedHours, availableHours) };
  }).filter((row) => row.booked > 0 || row.available > 0);
  const bookedTotal = rows.reduce((sum, row) => sum + row.booked, 0);
  const availableTotal = rows.reduce((sum, row) => sum + row.available, 0);

  return {
    report: "utilisation", range, currency: await loadCurrency(run, scope.tenantId), scopedToPerson: Boolean(scope.practitionerId),
    metrics: [
      { key: "utilisation", label: "Utilisation", value: utilisationPercent(bookedTotal, availableTotal), format: "percent", formula: "Utilisation: booked hours ÷ available hours. Booked counts bookings, check-ins, completed visits and no-shows; available is working hours.", href: bookingsHref(context, "past") },
      { key: "booked_hours", label: "Booked hours", value: round1(bookedTotal), format: "hours", formula: "Booked hours: the length of every booking that was not cancelled, declined or expired." },
      { key: "available_hours", label: "Available hours", value: round1(availableTotal), format: "hours", formula: "Available hours: the working hours set for each person, day by day, across the period." },
    ],
    charts: [{ key: "by_person", title: "Utilisation by staff member", kind: "bar", xKey: "name", series: [{ key: "rate", label: "Utilisation", format: "percent" }], rows: rows.map((row) => ({ name: row.name, rate: row.rate })) }],
    tables: [{
      key: "by_person", title: "By staff member", columns: [{ key: "name", label: "Staff member" }, { key: "booked", label: "Booked hours", format: "hours" }, { key: "available", label: "Available hours", format: "hours" }, { key: "rate", label: "Utilisation", format: "percent" }],
      hrefKey: "href", rows: rows.map((row) => ({ name: row.name, booked: row.booked, available: row.available, rate: row.rate, href: bookingsHref({ ...context, scope: { ...scope, practitionerId: row.id } }, "past") })),
    }],
  };
}
