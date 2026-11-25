import { sql, type SQL } from "drizzle-orm";

import { addDays, daysBetween, ratePercent, type ReportResult, type ReportTable } from "../../lib/reports";
import { SATISFIED_MIN } from "../../lib/reviews";
import { limitedLocations, loadCurrency, num, rangeOf, type ReportContext } from "./common";

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * How satisfied customers were (feature 51): the average rating, the share who gave four or five stars, and how many of the
 * people asked answered. Private and hidden reviews count here: the business sees all of its own feedback, and only the public
 * page leaves them out. Unlike the public average, this shows a figure from the first review, because the owner is the reader.
 */
export async function satisfactionReport(context: ReportContext): Promise<ReportResult> {
  const { run, scope, params } = context;
  const range = rangeOf(params);
  // A review lands on the day the customer answered, in the visit's own place.
  const base = sql`
    from reviews rv
    join appointments a on a.tenant_id = rv.tenant_id and a.id = rv.appointment_id
    join locations l on l.tenant_id = a.tenant_id and l.id = a.location_id
    join practitioners pr on pr.tenant_id = rv.tenant_id and pr.id = rv.practitioner_id
    join services s on s.tenant_id = rv.tenant_id and s.id = rv.service_id
    where rv.tenant_id = ${scope.tenantId}
      and rv.created_at >= ((${addDays(range.from, -1)}::date)::timestamp at time zone 'UTC')
      and rv.created_at < ((${addDays(range.to, 2)}::date)::timestamp at time zone 'UTC')
      and rv.created_at >= (${range.from}::date)::timestamp at time zone l.timezone
      and rv.created_at < (${addDays(range.to, 1)}::date)::timestamp at time zone l.timezone
      and not a.is_test and not a.is_sample
      ${scope.locationId ? sql`and a.location_id = ${scope.locationId}` : sql``}
      ${limitedLocations(scope, sql`a.location_id`)}
      ${scope.practitionerId ? sql`and rv.practitioner_id = ${scope.practitionerId}` : sql``}`;
  const stats = sql`count(*) as total, avg(rv.rating) as average, count(*) filter (where rv.rating >= ${SATISFIED_MIN}) as satisfied, count(*) filter (where rv.rating <= 2) as low`;
  const grouped = (label: SQL, order: SQL = sql`total desc, 1`) => run(sql`select ${label} as name, ${stats} ${base} group by 1 order by ${order}`);

  const byMonth = daysBetween(range.from, range.to) > 62;
  const bucket = byMonth ? sql`to_char(rv.created_at at time zone l.timezone, 'YYYY-MM')` : sql`to_char(rv.created_at at time zone l.timezone, 'YYYY-MM-DD')`;
  const [[overall], overTime, byPerson, byService, byBranch, [requests]] = await Promise.all([
    run(sql`select ${stats} ${base}`),
    grouped(bucket, sql`1`),
    grouped(sql`pr.name`),
    grouped(sql`s.name`),
    grouped(sql`l.name`),
    // Response rate: of the people asked in the period, how many answered. Asked is by the day the link went out.
    run(sql`
      select count(*) as sent, count(*) filter (where rq.answered_at is not null) as answered
      from rating_requests rq join appointments a on a.tenant_id = rq.tenant_id and a.id = rq.appointment_id
      join locations l on l.tenant_id = a.tenant_id and l.id = a.location_id
      where rq.tenant_id = ${scope.tenantId}
        and rq.sent_at >= ((${addDays(range.from, -1)}::date)::timestamp at time zone 'UTC')
        and rq.sent_at < ((${addDays(range.to, 2)}::date)::timestamp at time zone 'UTC')
        and rq.sent_at >= (${range.from}::date)::timestamp at time zone l.timezone
        and rq.sent_at < (${addDays(range.to, 1)}::date)::timestamp at time zone l.timezone
        ${scope.locationId ? sql`and a.location_id = ${scope.locationId}` : sql``}
        ${limitedLocations(scope, sql`a.location_id`)}
      ${limitedLocations(scope, sql`a.location_id`)}
        ${scope.practitionerId ? sql`and a.practitioner_id = ${scope.practitionerId}` : sql``}`),
  ]);

  const total = num(overall?.total);
  const average = total > 0 ? round1(num(overall?.average)) : null;
  const table = (key: string, title: string, label: string, rows: typeof byPerson): ReportTable => ({
    key, title, columns: [{ key: "name", label }, { key: "total", label: "Ratings", format: "count" }, { key: "average", label: "Average", format: "decimal" }, { key: "satisfaction", label: "Satisfied", format: "percent" }],
    rows: rows.map((row) => ({ name: String(row.name), total: num(row.total), average: round1(num(row.average)), satisfaction: ratePercent(num(row.satisfied), num(row.total)) })),
  });
  return {
    report: "satisfaction", range, currency: await loadCurrency(run, scope.tenantId), scopedToPerson: Boolean(scope.practitionerId),
    metrics: [
      { key: "average", label: "Average rating", value: average, format: "decimal", formula: "Average rating: the mean of every star rating left in the period, private feedback included." },
      { key: "satisfaction", label: "Satisfied", value: ratePercent(num(overall?.satisfied), total), format: "percent", formula: "Satisfied: ratings of 4 or 5 stars ÷ all ratings." },
      { key: "ratings", label: "Ratings", value: total, format: "count", formula: "Ratings: reviews left in the period, from the one-tap link, the manage page or staff." },
      { key: "low", label: "1 or 2 stars", value: num(overall?.low), format: "count", formula: "1 or 2 stars: ratings that alert the business so someone can call the customer." },
      { key: "response_rate", label: "Response rate", value: ratePercent(num(requests?.answered), num(requests?.sent)), format: "percent", formula: "Response rate: people who answered the one-tap rating link ÷ people it was sent to." },
    ],
    charts: [{ key: "over_time", title: byMonth ? "Average rating by month" : "Average rating by day", kind: "bar", xKey: "period", series: [{ key: "average", label: "Average rating", format: "decimal" }],
      rows: overTime.map((row) => ({ period: String(row.name), average: round1(num(row.average)) })) }],
    tables: [table("by_person", "By staff member", "Staff member", byPerson), table("by_service", "By service", "Service", byService), table("by_branch", "By place", "Place", byBranch)],
  };
}
