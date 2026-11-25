import { sql } from "drizzle-orm";

import { bookingSourceLabels } from "../../lib/bookings-list";
import type { ReportResult } from "../../lib/reports";
import { appointmentWhere, bookingsHref, BOOKED_STATUSES, loadCurrency, num, rangeOf, type ReportContext } from "./common";

const HEARD_FROM: Record<string, string> = { search: "Online search", social: "Social media", friend: "A friend", referral: "A referral", walk_by: "Walked past", other: "Somewhere else" };

/** Where bookings came from: the channel, the campaign tags on the link, and what customers said when asked. */
export async function sourcesReport(context: ReportContext): Promise<ReportResult> {
  const { run, scope } = context;
  const range = rangeOf(context.params);
  const from = sql`from appointments a join locations l on l.tenant_id = a.tenant_id and l.id = a.location_id where ${appointmentWhere(scope, range)} and a.status in ${BOOKED_STATUSES}`;
  const [bySource, campaigns, heard, [total]] = await Promise.all([
    run(sql`select a.booking_source::text as source, count(*) as total ${from} group by 1 order by total desc`),
    run(sql`select a.utm_campaign as campaign, coalesce(a.utm_source, '') as source, coalesce(a.utm_medium, '') as medium, count(*) as total,
      count(*) filter (where a.status = 'completed') as completed ${from} and a.utm_campaign is not null group by 1, 2, 3 order by total desc, 1 limit 100`),
    run(sql`select a.heard_from as answer, count(*) as total ${from} and a.heard_from is not null group by 1 order by total desc`),
    run(sql`select count(*) as total ${from}`),
  ]);
  return {
    report: "sources", range, currency: await loadCurrency(run, scope.tenantId), scopedToPerson: Boolean(scope.practitionerId),
    metrics: [{ key: "bookings", label: "Bookings", value: num(total?.total), format: "count", formula: "Bookings: appointments in the period that were not cancelled, declined or expired.", href: bookingsHref(context, "past") }],
    charts: [{ key: "by_source", title: "Bookings by source", kind: "bar", xKey: "name", series: [{ key: "total", label: "Bookings" }],
      rows: bySource.map((row) => ({ name: bookingSourceLabels[String(row.source) as keyof typeof bookingSourceLabels] ?? String(row.source), total: num(row.total) })) }],
    tables: [
      { key: "by_source", title: "By source", hrefKey: "href", columns: [{ key: "name", label: "Source" }, { key: "total", label: "Bookings", format: "count" }],
        rows: bySource.map((row) => ({ name: bookingSourceLabels[String(row.source) as keyof typeof bookingSourceLabels] ?? String(row.source), total: num(row.total), href: bookingsHref(context, "past", { sources: String(row.source) }) })) },
      { key: "campaigns", title: "By campaign", note: "From the utm_campaign, utm_source and utm_medium tags on the booking link.", hrefKey: "href",
        columns: [{ key: "campaign", label: "Campaign", format: "text" }, { key: "source", label: "Source", format: "text" }, { key: "medium", label: "Medium", format: "text" }, { key: "total", label: "Bookings", format: "count" }, { key: "completed", label: "Completed", format: "count" }],
        rows: campaigns.map((row) => ({ campaign: String(row.campaign), source: String(row.source), medium: String(row.medium), total: num(row.total), completed: num(row.completed), href: bookingsHref(context, "past", { utmCampaign: String(row.campaign) }) })) },
      { key: "heard_from", title: "How customers say they heard about you", columns: [{ key: "name", label: "Answer" }, { key: "total", label: "Customers", format: "count" }],
        rows: heard.map((row) => ({ name: HEARD_FROM[String(row.answer)] ?? String(row.answer), total: num(row.total) })) },
    ],
  };
}
