import { sql, type SQL } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import { type BookingFilter, type SeriesStatus } from "@/lib/bookings-list";
import { locationCondition } from "@/server/location-scope";
import type { StaffContext } from "@/server/staff-context";

/**
 * The conditions of the Repeating tab (feature 17) on `appointment_series as series`, with its customer joined as `patient`.
 * Kept apart from the list itself so the bookings list can show this tab's count without importing the series list.
 */

const inList = (values: readonly string[]): SQL => sql.join(values.map((value) => sql`${value}`), sql`, `);
const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (character) => `\\${character}`);

export const seriesFrom = sql`
  from appointment_series as series
  join patients as patient on patient.tenant_id = series.tenant_id and patient.id = series.patient_id
  join services as service on service.tenant_id = series.tenant_id and service.id = series.service_id
  join practitioners as practitioner on practitioner.tenant_id = series.tenant_id and practitioner.id = series.practitioner_id
  join locations as location on location.tenant_id = series.tenant_id and location.id = series.location_id
`;

/** A practitioner sees their own series only, like their own bookings. */
export async function seriesScope(transaction: KalendrTransaction, context: StaffContext): Promise<SQL | null> {
  const location = locationCondition(context, sql`series.location_id`);
  if (context.role !== "practitioner") return location;
  const own = await transaction.execute<{ id: string }>(sql`select id from practitioners where tenant_id = ${context.tenantId} and auth_user_id = ${context.userId} limit 1`);
  const mine = own[0] ? sql`series.practitioner_id = ${own[0].id}` : sql`false`;
  return location ? sql`${location} and ${mine}` : mine;
}

/** Each present filter is one bound condition. No chosen status means the running series. */
export function seriesConditions(tenantId: string, filter: BookingFilter): SQL[] {
  const statuses: SeriesStatus[] = filter.seriesStatuses?.length ? filter.seriesStatuses : ["active"];
  const conditions: SQL[] = [sql`series.tenant_id = ${tenantId}`, sql`series.status in (${inList(statuses)})`];
  if (filter.practitionerIds?.length) conditions.push(sql`series.practitioner_id in (${inList(filter.practitionerIds)})`);
  if (filter.serviceIds?.length) conditions.push(sql`series.service_id in (${inList(filter.serviceIds)})`);
  if (filter.locationIds?.length) conditions.push(sql`series.location_id in (${inList(filter.locationIds)})`);
  if (filter.q) {
    const text = filter.q.trim();
    const digits = text.replace(/\D/g, "");
    const byName = sql`(patient.first_name || ' ' || patient.last_name) ilike ${`%${escapeLike(text)}%`}`;
    conditions.push(digits.length >= 3 && digits.length >= text.replace(/[\s()+-]/g, "").length
      ? sql`(${byName} or kalendr_normalize_phone(patient.phone) like ${`%${digits}%`})`
      : byName);
  }
  return conditions;
}

/** How many series the tab holds under these filters, for the tab's badge. */
export async function countSeries(transaction: KalendrTransaction, context: StaffContext, filter: BookingFilter): Promise<number> {
  const scope = await seriesScope(transaction, context);
  const where = sql.join([...seriesConditions(context.tenantId, filter), ...(scope ? [scope] : [])], sql` and `);
  const [row] = await transaction.execute<{ total: number }>(sql`select count(*)::int as total ${seriesFrom} where ${where}`);
  return Number(row?.total ?? 0);
}
