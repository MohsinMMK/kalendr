import { sql, type SQL } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import { ApiError } from "@/server/api-error";
import type { StaffContext } from "@/server/staff-context";

/**
 * Branch-limited staff. An owner or admin can limit a team member to some of the business's locations
 * (`membership_locations`); that person then sees and acts on those locations only. `context.locationIds` is null for
 * everyone who is not limited (owners always), so every check here starts with "null means no limit".
 *
 * Reading another location's record answers 404 (the record is "not there" for this person); creating or moving a
 * booking into another location answers 403.
 */

type LocationScoped = Pick<StaffContext, "locationIds">;

/** The locations this person is limited to, or null for all of them. */
export function allowedLocationIds(context: LocationScoped): string[] | null {
  return context.locationIds && context.locationIds.length > 0 ? context.locationIds : null;
}

export function isLimitedToLocations(context: LocationScoped): boolean {
  return allowedLocationIds(context) !== null;
}

/** True when this person may see and act on records at the location. A record with no location (null) is business-wide. */
export function canUseLocation(context: LocationScoped, locationId: string | null | undefined): boolean {
  const allowed = allowedLocationIds(context);
  if (!allowed || !locationId) return true;
  return allowed.includes(locationId);
}

/** A condition on `column` (such as sql`appointment.location_id`), or null when this person is not limited. */
export function locationCondition(context: LocationScoped, column: SQL): SQL | null {
  const allowed = allowedLocationIds(context);
  if (!allowed) return null;
  return sql`${column} in (${sql.join(allowed.map((id) => sql`${id}`), sql`, `)})`;
}

/** The same condition as a fragment to append after `and`, or an empty fragment when there is no limit. */
export function andLocation(context: LocationScoped, column: SQL): SQL {
  const condition = locationCondition(context, column);
  return condition ? sql`and ${condition}` : sql``;
}

/** Like `locationCondition`, but a row with no location (a business-wide block, say) stays visible. */
export function locationOrNoneCondition(context: LocationScoped, column: SQL): SQL | null {
  const condition = locationCondition(context, column);
  return condition ? sql`(${column} is null or ${condition})` : null;
}

/** A visit, queue ticket or class at a location this person may not use reads as missing. */
export function assertLocationVisible(context: LocationScoped, locationId: string | null | undefined, notFound: () => ApiError): void {
  if (!canUseLocation(context, locationId)) throw notFound();
}

/** Booking or moving a visit into a location this person may not use. */
export function assertLocationAllowed(context: LocationScoped, locationId: string | null | undefined): void {
  if (canUseLocation(context, locationId)) return;
  throw new ApiError(403, "location_not_allowed", "You can only work at the locations the owner gave you. Pick one of those.");
}

/** Keeps the locations a limited person may use; everyone else gets the list unchanged. */
export function filterAllowedLocations<T extends { id: string }>(context: LocationScoped, locations: readonly T[]): T[] {
  const allowed = allowedLocationIds(context);
  return allowed ? locations.filter((location) => allowed.includes(location.id)) : [...locations];
}

/**
 * Which customers a location-limited person sees: those with a visit or a waitlist entry at one of their locations, and
 * those with no visit anywhere yet (a customer someone just created has no location to belong to). A customer who has
 * only been seen at other locations is hidden. `patientId` is the column to test, such as sql`patient.id`. Qualify it with its table: the subqueries below have their own `id` and `patient_id`.
 */
export function visibleCustomerCondition(context: LocationScoped & Pick<StaffContext, "tenantId">, patientId: SQL): SQL | null {
  const allowed = allowedLocationIds(context);
  if (!allowed) return null;
  const list = sql.join(allowed.map((id) => sql`${id}`), sql`, `);
  return sql`(
    exists (select 1 from appointments as seen_at where seen_at.tenant_id = ${context.tenantId} and seen_at.patient_id = ${patientId} and seen_at.location_id in (${list}))
    or exists (select 1 from waitlist_entries as waiting_at where waiting_at.tenant_id = ${context.tenantId} and waiting_at.patient_id = ${patientId} and waiting_at.location_id in (${list}))
    or not exists (select 1 from appointments as any_visit where any_visit.tenant_id = ${context.tenantId} and any_visit.patient_id = ${patientId})
  )`;
}

/** `visibleCustomerCondition` as a fragment to append after other conditions, empty when there is no limit. */
export function andVisibleCustomer(context: LocationScoped & Pick<StaffContext, "tenantId">, patientId: SQL): SQL {
  const condition = visibleCustomerCondition(context, patientId);
  return condition ? sql`and ${condition}` : sql``;
}

/** Whether a location-limited person may open this customer. Always true for anyone who is not limited. */
export async function customerVisibleHere(transaction: KalendrTransaction, context: LocationScoped & Pick<StaffContext, "tenantId">, patientId: string): Promise<boolean> {
  const condition = visibleCustomerCondition(context, sql`${patientId}::text`);
  if (!condition) return true;
  const rows = await transaction.execute<{ visible: boolean }>(sql`select ${condition} as visible`);
  return rows[0]?.visible === true;
}

/** A visit at a location this person may not use reads as not found. For the single-visit screens that load it by id. */
export async function assertAppointmentVisibleHere(transaction: KalendrTransaction, context: LocationScoped & Pick<StaffContext, "tenantId">, appointmentId: string): Promise<void> {
  if (!isLimitedToLocations(context)) return;
  const [visit] = await transaction.execute<{ location_id: string }>(sql`select location_id from appointments where tenant_id = ${context.tenantId} and id = ${appointmentId}`);
  if (visit && !canUseLocation(context, visit.location_id)) throw new ApiError(404, "appointment_not_found", "That visit could not be found.");
}
