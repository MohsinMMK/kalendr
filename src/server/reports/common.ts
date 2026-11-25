/**
 * Shared pieces of the report queries (feature 26). No "server-only": the worker builds large exports with the same code,
 * through a `Runner`, so a number in a CSV can never differ from the one on the screen.
 *
 * Every figure is worked out in the location's own timezone. A raw `starts_at` range (widened by a day on each side) lets
 * PostgreSQL use the date indexes; the exact local-day edges are then applied per location, so a Monday is the business's Monday.
 */
import { TZDate } from "@date-fns/tz";
import { sql, type SQL } from "drizzle-orm";

import { addDays, type ReportParams } from "../../lib/reports";
import type { Runner } from "../workflows/runner";

export interface ReportScope {
  tenantId: string;
  locationId?: string;
  /** Set by the server for a person limited to some locations: every report reads those locations only, whatever the request says. */
  locationIds?: string[];
  practitionerId?: string;
  /** Set by the server for a practitioner: the filter is theirs and cannot be widened from the request. */
  forcedPractitioner: boolean;
  canSeeRevenue: boolean;
}

export interface Range { from: string; to: string }

export interface ReportContext {
  run: Runner;
  scope: ReportScope;
  params: ReportParams;
  /** The business's timezone, for the days in click-through links. */
  timezone: string;
  now: Date;
}

/** Statuses that count as a booking that happened or was due to happen. */
export const BOOKED_STATUSES = sql.raw("('booked','checked_in','completed','no_show')");
/** Statuses where the visit was due and its outcome is known. */
export const DUE_STATUSES = sql.raw("('completed','no_show')");
/**
 * Statuses that count as booked time in utilisation: the slot was used or held.
 * @alias
 */
export const OCCUPIED_STATUSES = BOOKED_STATUSES;

/**
 * The appointment rows one report reads: this business, inside the range in each location's own timezone, leaving out test
 * and sample bookings, ones marked entered in error, and ones staff reported as spam. Aliases: `a` appointment, `l` location.
 */
export function appointmentWhere(scope: ReportScope, range: Range): SQL {
  return sql`a.tenant_id = ${scope.tenantId}
    and a.starts_at >= ((${addDays(range.from, -1)}::date)::timestamp at time zone 'UTC')
    and a.starts_at < ((${addDays(range.to, 2)}::date)::timestamp at time zone 'UTC')
    and a.starts_at >= (${range.from}::date)::timestamp at time zone l.timezone
    and a.starts_at < (${addDays(range.to, 1)}::date)::timestamp at time zone l.timezone
    and not a.is_test and not a.is_sample and a.status <> 'entered_in_error' and a.spam_state <> 'reported'
    ${scope.locationId ? sql`and a.location_id = ${scope.locationId}` : sql``}
    ${limitedLocations(scope, sql`a.location_id`)}
    ${scope.practitionerId ? sql`and a.practitioner_id = ${scope.practitionerId}` : sql``}`;
}

/** `and column in (...)` for a person limited to some locations, nothing for everyone else. */
export function limitedLocations(scope: Pick<ReportScope, "locationIds">, column: SQL): SQL {
  return scope.locationIds?.length ? sql`and ${column} in (${sql.join(scope.locationIds.map((id) => sql`${id}`), sql`, `)})` : sql``;
}

/** The same exclusions for payments and refunds, by the day the money moved. Aliases: `p` payment, `l` location, `a` appointment (may be null). */
export function paymentWhere(scope: ReportScope, range: Range, createdColumn: SQL = sql`p.created_at`): SQL {
  return sql`p.tenant_id = ${scope.tenantId}
    and ${createdColumn} >= ((${addDays(range.from, -1)}::date)::timestamp at time zone 'UTC')
    and ${createdColumn} < ((${addDays(range.to, 2)}::date)::timestamp at time zone 'UTC')
    and ${createdColumn} >= (${range.from}::date)::timestamp at time zone l.timezone
    and ${createdColumn} < (${addDays(range.to, 1)}::date)::timestamp at time zone l.timezone
    and not p.is_test
    ${scope.locationId ? sql`and l.id = ${scope.locationId}` : sql``}
    ${limitedLocations(scope, sql`l.id`)}
    ${scope.practitionerId ? sql`and a.practitioner_id = ${scope.practitionerId}` : sql``}`;
}

/** Payments with the place they were taken (the visit's place, or the sale's own) so they bucket in the right timezone. */
export const PAYMENT_FROM = sql`payments p
  left join appointments a on a.tenant_id = p.tenant_id and a.id = p.appointment_id
  join locations l on l.tenant_id = p.tenant_id and l.id = coalesce(a.location_id, p.location_id)`;

export const num = (value: unknown): number => Number(value ?? 0);

/** The business's own midnight on a local day, as an instant with an offset, which is what the bookings list reads. */
export function localInstant(day: string, timeZone: string, endOfDay = false): string {
  const date = new TZDate(`${endOfDay ? addDays(day, 1) : day}T00:00:00`, timeZone);
  return new Date(endOfDay ? date.getTime() - 1 : date.getTime()).toISOString();
}

/** The path the bookings list opens at for this range, with extra filters. Dates are the business's own days. */
export function bookingsHref(
  context: Pick<ReportContext, "params" | "scope" | "timezone">,
  tab: "past" | "upcoming" | "cancelled",
  extra: Record<string, string | undefined> = {},
): string {
  const query = new URLSearchParams({ tab, from: localInstant(context.params.from, context.timezone), to: localInstant(context.params.to, context.timezone, true) });
  if (context.scope.locationId) query.set("locationIds", context.scope.locationId);
  if (context.scope.practitionerId) query.set("practitionerIds", context.scope.practitionerId);
  for (const [key, value] of Object.entries(extra)) if (value) query.set(key, value);
  return `/bookings?${query.toString()}`;
}

export function rangeOf(params: Pick<ReportParams, "from" | "to">): Range {
  return { from: params.from, to: params.to };
}

/** The tenant's money currency: whatever its payments use, else rupees. */
export async function loadCurrency(run: Runner, tenantId: string): Promise<string> {
  const [row] = await run(sql`select currency from payments where tenant_id = ${tenantId} order by created_at desc limit 1`);
  return typeof row?.currency === "string" ? row.currency : "INR";
}
