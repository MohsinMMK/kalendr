import "server-only";

import { sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { ABANDON_AFTER_HOURS, type RoutingReport } from "@/lib/routing-forms";
import { ApiError } from "@/server/api-error";
import { requirePermission, type StaffContext } from "@/server/staff-context";

/**
 * Routing form numbers (feature 46): the funnel, each route's results, and who answered but did not book. Counted from
 * the response rows at read time with `now` passed in, so nothing flips in the background and the numbers can be tested.
 */

const DAY = 86_400_000;

interface Range { from: Date; to: Date }

export function reportRange(input: { from?: string | undefined; to?: string | undefined }, now: Date): Range {
  const to = input.to ? new Date(input.to) : now;
  const from = input.from ? new Date(input.from) : new Date(to.getTime() - 30 * DAY);
  if (from >= to) throw new ApiError(400, "validation_error", "The start of the range must be before its end.");
  if (to.getTime() - from.getTime() > 366 * DAY) throw new ApiError(400, "validation_error", "Choose a range of a year or less.");
  return { from, to };
}

export async function routingReport(context: StaffContext, formId: string | null, input: { from?: string | undefined; to?: string | undefined }, now: Date = new Date()): Promise<RoutingReport> {
  requirePermission(context, "routing.manage");
  if (context.preview) throw new ApiError(503, "database_unavailable", "Routing reports need the live database.");
  const { from, to } = reportRange(input, now);
  const cutoff = new Date(now.getTime() - ABANDON_AFTER_HOURS * 3_600_000);
  const weekStart = new Date(to.getTime() - 7 * DAY);
  return withTenant(context.tenantId, async (transaction) => {
    const form = formId ? sql`and response.form_id = ${formId}` : sql``;
    const [funnel] = await transaction.execute<Record<string, number | string>>(sql`
      select count(*) as opened, count(response.answered_at) as answered, count(response.slot_shown_at) as slot_shown, count(response.booked_at) as booked,
        count(*) filter (where response.destination_type = 'service' and response.answered_at is not null and response.booked_at is null and response.answered_at <= ${cutoff.toISOString()}::timestamptz) as not_booked,
        count(*) filter (where response.destination_type = 'service' and response.answered_at is not null and response.booked_at is null and response.answered_at <= ${cutoff.toISOString()}::timestamptz
          and response.answered_at > ${weekStart.toISOString()}::timestamptz and response.answered_at <= ${to.toISOString()}::timestamptz) as not_booked_week
      from routing_responses as response
      where response.tenant_id = ${context.tenantId} and response.opened_at >= ${from.toISOString()}::timestamptz and response.opened_at < ${to.toISOString()}::timestamptz ${form}
    `);
    const routes = formId ? await transaction.execute<{ route_id: string; route_name: string; responses: number | string; booked: number | string; not_booked: number | string }>(sql`
      select response.route_id, max(response.route_name) as route_name, count(*) as responses, count(response.booked_at) as booked,
        count(*) filter (where response.destination_type = 'service' and response.booked_at is null and response.answered_at <= ${cutoff.toISOString()}::timestamptz) as not_booked
      from routing_responses as response
      where response.tenant_id = ${context.tenantId} and response.answered_at is not null and response.route_id is not null
        and response.opened_at >= ${from.toISOString()}::timestamptz and response.opened_at < ${to.toISOString()}::timestamptz ${form}
      group by response.route_id order by responses desc, response.route_id
    `) : [];
    // The week is counted independently of the range: "last week" means the seven days before the end of the range.
    const [week] = await transaction.execute<{ n: number | string }>(sql`
      select count(*) as n from routing_responses as response
      where response.tenant_id = ${context.tenantId} ${form} and response.destination_type = 'service' and response.booked_at is null
        and response.answered_at > ${weekStart.toISOString()}::timestamptz and response.answered_at <= ${new Date(Math.min(to.getTime(), cutoff.getTime())).toISOString()}::timestamptz
    `);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      opened: Number(funnel?.opened ?? 0),
      answered: Number(funnel?.answered ?? 0),
      slotShown: Number(funnel?.slot_shown ?? 0),
      booked: Number(funnel?.booked ?? 0),
      answeredNotBooked: Number(funnel?.not_booked ?? 0),
      abandonedAfterHours: ABANDON_AFTER_HOURS,
      perRoute: routes.map((row) => ({ routeId: row.route_id, name: row.route_name, responses: Number(row.responses), booked: Number(row.booked), notBooked: Number(row.not_booked) })),
      answeredNotBookedLastWeek: Number(week?.n ?? 0),
    };
  });
}

/** Spreadsheet programs run a cell that starts with one of these as a formula, so such text is made plain. */
export function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * One row per response with the route and the funnel steps. It never includes what the customer typed, nor the sealed
 * answers, nor any contact detail: that stays in the app.
 */
export async function routingCsv(context: StaffContext, formId: string | null, input: { from?: string | undefined; to?: string | undefined }, now: Date = new Date()): Promise<string> {
  requirePermission(context, "routing.manage");
  if (context.preview) throw new ApiError(503, "database_unavailable", "Routing reports need the live database.");
  const { from, to } = reportRange(input, now);
  const rows = await withTenant(context.tenantId, async (transaction) => transaction.execute<{
    id: string; form_name: string; form_version: number; route_name: string | null; destination_type: string | null; outcome: string;
    opened_at: Date | string; answered_at: Date | string | null; slot_shown_at: Date | string | null; booked_at: Date | string | null;
  }>(sql`
    select response.id, version.name as form_name, response.form_version, response.route_name, response.destination_type, response.outcome,
      response.opened_at, response.answered_at, response.slot_shown_at, response.booked_at
    from routing_responses as response
    join routing_form_versions as version on version.tenant_id = response.tenant_id and version.form_id = response.form_id and version.version = response.form_version
    where response.tenant_id = ${context.tenantId} and response.opened_at >= ${from.toISOString()}::timestamptz and response.opened_at < ${to.toISOString()}::timestamptz
      ${formId ? sql`and response.form_id = ${formId}` : sql``}
    order by response.opened_at desc limit 50000
  `));
  const iso = (value: Date | string | null) => (value === null ? "" : new Date(value).toISOString());
  const lines = [["response", "form", "version", "route", "goes_to", "outcome", "opened", "answered", "times_shown", "booked"].join(",")];
  for (const row of rows) {
    lines.push([row.id, row.form_name, row.form_version, row.route_name, row.destination_type, row.outcome, iso(row.opened_at), iso(row.answered_at), iso(row.slot_shown_at), iso(row.booked_at)].map((cell) => csvCell(cell === "" ? null : cell)).join(","));
  }
  return `${lines.join("\n")}\n`;
}
