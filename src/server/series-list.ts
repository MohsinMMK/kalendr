import "server-only";

import { sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { type BookingTab } from "@/lib/bookings-list";
import { parseStoredRule, ruleSummary } from "@/lib/series-rule";
import type { SeriesListPage, SeriesListQuery, SeriesListRow } from "@/lib/series-list";
import { profileWords } from "@/lib/terminology";
import { ApiError } from "@/server/api-error";
import { loadBusinessProfileIn } from "@/server/business-profile";
import { decodeCursor, encodeCursor, filterConditions, fromClause, scopeFor, tabCondition } from "@/server/bookings-list";
import { countSeries, seriesConditions, seriesFrom, seriesScope } from "@/server/series-count";
import { requirePermission, type StaffContext } from "@/server/staff-context";

/**
 * The Repeating tab of the bookings list (feature 17 in feature 43): one row per series, with the next visit still ahead and how
 * many visits are done. One parameterised query from a validated filter object, paged by cursor on (next visit, id); a series with
 * nothing ahead sorts after the others. Reading needs the same permission as the rest of the list, and a practitioner sees their own.
 */

/** A visit still ahead. `checked_in` counts: someone is in the building for it now. */
const OPEN_VISIT = ["booked", "requested", "checked_in", "reschedule_requested"] as const;
/** Visits that no longer belong to the plan. */
const DROPPED_VISIT = ["cancelled", "declined", "expired", "entered_in_error"] as const;
/** What a series with nothing ahead sorts as, so every row has a cursor key. */
const NEVER = "9999-12-31T00:00:00.000Z";

interface Row extends Record<string, unknown> {
  id: string;
  version: number;
  status: SeriesListRow["status"];
  patient_id: string;
  first_name: string;
  last_name: string;
  service_id: string;
  service_name: string;
  practitioner_id: string;
  practitioner_name: string;
  location_id: string;
  location_name: string;
  timezone: string;
  rule: unknown;
  starts_on: string;
  time_of_day: string;
  next_id: string | null;
  next_starts_at: Date | string | null;
  next_index: number | null;
  sort_at: Date | string;
  visits_done: number;
  visits_total: number;
}

const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();
const list = (values: readonly string[]) => sql.join(values.map((value) => sql`${value}`), sql`, `);

export async function listSeries(context: StaffContext, query: SeriesListQuery, options: { now?: Date } = {}): Promise<SeriesListPage> {
  requirePermission(context, "appointments.status");
  if (context.preview) throw new ApiError(400, "preview_only", "The bookings list needs a database.");
  const now = options.now ?? new Date();
  const cursor = decodeCursor(query.cursor);
  const ascending = query.sort === "asc";
  return withTenant(context.tenantId, async (transaction) => {
    const scope = await seriesScope(transaction, context);
    const shared = [...seriesConditions(context.tenantId, query), ...(scope ? [scope] : [])];
    const sortKey = sql`coalesce(upcoming.starts_at, ${NEVER}::timestamptz)`;
    const after = cursor
      ? (ascending ? sql` and (${sortKey}, series.id) > (${cursor.startsAt}::timestamptz, ${cursor.id})` : sql` and (${sortKey}, series.id) < (${cursor.startsAt}::timestamptz, ${cursor.id})`)
      : sql``;
    const rows = await transaction.execute<Row>(sql`
      select series.id, series.version, series.status, series.patient_id, patient.first_name, patient.last_name,
        series.service_id, service.name as service_name, series.practitioner_id, practitioner.name as practitioner_name,
        series.location_id, location.name as location_name, coalesce(location.timezone, tenant.timezone) as timezone,
        series.rule, series.starts_on::text as starts_on, series.time_of_day,
        upcoming.id as next_id, upcoming.starts_at as next_starts_at, upcoming.series_index as next_index,
        ${sortKey} as sort_at, coalesce(visits.done, 0) as visits_done, coalesce(visits.total, 0) as visits_total
      ${seriesFrom}
      join tenants as tenant on tenant.id = series.tenant_id
      left join lateral (
        select visit.id, visit.starts_at, visit.series_index from appointments as visit
        where visit.tenant_id = series.tenant_id and visit.series_id = series.id
          and visit.status::text in (${list(OPEN_VISIT)}) and visit.ends_at >= ${now.toISOString()}::timestamptz
        order by visit.starts_at, visit.series_index limit 1
      ) as upcoming on true
      left join lateral (
        select count(*) filter (where visit.status::text in ('completed', 'no_show'))::int as done,
          count(*) filter (where visit.status::text not in (${list(DROPPED_VISIT)}))::int as total
        from appointments as visit where visit.tenant_id = series.tenant_id and visit.series_id = series.id
      ) as visits on true
      where ${sql.join(shared, sql` and `)}${after}
      order by ${sortKey} ${ascending ? sql`asc` : sql`desc`}, series.id ${ascending ? sql`asc` : sql`desc`}
      limit ${query.limit + 1}
    `);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > query.limit && last ? encodeCursor(new Date(last.sort_at), last.id) : null;
    const words = profileWords(await loadBusinessProfileIn(transaction, context.tenantId));
    const mapped: SeriesListRow[] = [];
    for (const row of page) {
      const rule = parseStoredRule(row.rule);
      mapped.push({
        id: row.id, version: Number(row.version), status: row.status,
        customer: { id: row.patient_id, name: `${row.first_name} ${row.last_name}`.trim() },
        service: { id: row.service_id, name: row.service_name },
        practitioner: { id: row.practitioner_id, name: row.practitioner_name },
        location: { id: row.location_id, name: row.location_name },
        summary: rule ? ruleSummary(rule, row.starts_on, row.time_of_day, { visit: words.visit, visits: words.visits }) : "Repeats on a custom pattern",
        timezone: row.timezone,
        nextVisit: row.next_id && row.next_starts_at ? { appointmentId: row.next_id, startsAt: iso(row.next_starts_at), index: Number(row.next_index ?? 1) } : null,
        visitsDone: Number(row.visits_done), visitsTotal: Number(row.visits_total),
      });
    }
    if (cursor) return { rows: mapped, nextCursor, counts: null, repeatingCount: null };

    // Every tab's count under the same filters, so the badges are right whichever tab is open.
    const appointmentScope = await scopeFor(transaction, context);
    const sharedAppointments = [sql`appointment.tenant_id = ${context.tenantId}`, ...filterConditions(query), ...(appointmentScope ? [appointmentScope] : [])];
    const [counts] = await transaction.execute<Record<BookingTab, number>>(sql`
      select
        count(*) filter (where ${tabCondition("upcoming", now)})::int as upcoming,
        count(*) filter (where ${tabCondition("needs_approval", now)})::int as needs_approval,
        count(*) filter (where ${tabCondition("past", now)})::int as past,
        count(*) filter (where ${tabCondition("cancelled", now)})::int as cancelled
      ${query.q ? fromClause : sql`from appointments as appointment`}
      where ${sql.join(sharedAppointments, sql` and `)}
    `);
    return {
      rows: mapped, nextCursor,
      counts: { upcoming: Number(counts?.upcoming ?? 0), needs_approval: Number(counts?.needs_approval ?? 0), past: Number(counts?.past ?? 0), cancelled: Number(counts?.cancelled ?? 0) },
      repeatingCount: await countSeries(transaction, context, query),
    };
  });
}

