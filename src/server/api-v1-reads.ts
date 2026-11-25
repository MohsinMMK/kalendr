import "server-only";

import { and, asc, desc, eq, gt, isNull, sql, type SQL } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { appointments, locations, patients, practitioners, services } from "@/db/schema";
import { ApiError } from "@/server/api-error";
import type {
  V1Appointment, V1Customer, V1Service, V1Staff,
} from "@/server/api-v1-contracts";
import { decodeCursor, pageOf } from "@/server/api-v1";

/**
 * Everything the v1 routes read. Each query runs inside `withTenant` and also names the business in its where
 * clause, so a mistake in one place cannot widen the other (row-level security is the second lock, not the only one).
 */

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

type ServiceRow = typeof services.$inferSelect;
type StaffRow = typeof practitioners.$inferSelect;
type AppointmentRow = typeof appointments.$inferSelect;
type CustomerRow = typeof patients.$inferSelect;

export function toService(row: ServiceRow): V1Service {
  return {
    id: row.id, name: row.name, description: row.description, durationMinutes: row.durationMinutes,
    priceMinor: row.priceMinor ?? null, priceLabel: row.priceLabel ?? null, category: row.category ?? null,
    bookingMode: row.mode, isActive: row.isActive,
  };
}

export function toStaff(row: StaffRow): V1Staff {
  return { id: row.id, name: row.name, title: row.title, specialty: row.specialty, isActive: row.isActive };
}

export function toAppointment(row: AppointmentRow): V1Appointment {
  return {
    id: row.id, status: row.status, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(),
    serviceId: row.serviceId, staffId: row.practitionerId, customerId: row.patientId, locationId: row.locationId,
    source: row.bookingSource, notes: row.notes ?? null, reasonForVisit: row.reasonForVisit ?? null,
    version: row.version, createdAt: row.createdAt.toISOString(), cancelledAt: row.cancelledAt?.toISOString() ?? null,
  };
}

export function toCustomer(row: CustomerRow): V1Customer {
  return {
    id: row.id, firstName: row.firstName, lastName: row.lastName, phone: row.phone, email: row.email,
    dateOfBirth: row.dateOfBirth ?? null, tags: [], blocked: row.blockedAt !== null, createdAt: row.createdAt.toISOString(),
  };
}

/** Adds each customer's tag names (feature 27) in one query for the whole page. */
async function withTags(tenantId: string, customers: V1Customer[]): Promise<V1Customer[]> {
  if (customers.length === 0) return customers;
  const rows = await withTenant(tenantId, (tx) => tx.execute<{ patient_id: string; name: string }>(sql`
    select link.patient_id, tag.name from customer_tag_links as link
    join customer_tags as tag on tag.tenant_id = link.tenant_id and tag.id = link.tag_id
    where link.tenant_id = ${tenantId} and link.patient_id in (${sql.join(customers.map((customer) => sql`${customer.id}`), sql`, `)})
    order by lower(tag.name)
  `));
  const byCustomer = new Map<string, string[]>();
  for (const row of rows) byCustomer.set(row.patient_id, [...(byCustomer.get(row.patient_id) ?? []), row.name]);
  return customers.map((customer) => ({ ...customer, tags: byCustomer.get(customer.id) ?? [] }));
}

export async function listServices(tenantId: string, limit: number, cursor: string | undefined): Promise<Page<V1Service>> {
  const after = decodeCursor(cursor);
  const rows = await withTenant(tenantId, (tx) => tx.select().from(services)
    .where(and(eq(services.tenantId, tenantId), after ? gt(services.id, after.id) : undefined))
    .orderBy(asc(services.id)).limit(limit + 1));
  const page = pageOf(rows, limit, (row) => ({ t: "id", id: row.id }));
  return { items: page.items.map(toService), nextCursor: page.nextCursor };
}

export async function listStaff(tenantId: string, limit: number, cursor: string | undefined): Promise<Page<V1Staff>> {
  const after = decodeCursor(cursor);
  const rows = await withTenant(tenantId, (tx) => tx.select().from(practitioners)
    .where(and(eq(practitioners.tenantId, tenantId), after ? gt(practitioners.id, after.id) : undefined))
    .orderBy(asc(practitioners.id)).limit(limit + 1));
  const page = pageOf(rows, limit, (row) => ({ t: "id", id: row.id }));
  return { items: page.items.map(toStaff), nextCursor: page.nextCursor };
}

export async function findService(tenantId: string, serviceId: string): Promise<V1Service> {
  const [row] = await withTenant(tenantId, (tx) => tx.select().from(services)
    .where(and(eq(services.tenantId, tenantId), eq(services.id, serviceId))).limit(1));
  if (!row) throw new ApiError(404, "service_not_found", "Service not found.");
  return toService(row);
}

/** The location used when a call does not name one: the business's first active location, by creation. */
export async function defaultLocationId(tenantId: string): Promise<string> {
  const [row] = await withTenant(tenantId, (tx) => tx.select({ id: locations.id }).from(locations)
    .where(and(eq(locations.tenantId, tenantId), eq(locations.isActive, true)))
    .orderBy(asc(locations.createdAt), asc(locations.id)).limit(1));
  if (!row) throw new ApiError(409, "no_location", "This business has no active location.");
  return row.id;
}

export interface AppointmentFilters {
  from?: string;
  to?: string;
  status?: V1Appointment["status"];
  customerId?: string;
}

/** Newest start first. The cursor is the last row's start time and id, so paging stays stable while rows are added. */
export async function listAppointments(tenantId: string, filters: AppointmentFilters, limit: number, cursor: string | undefined): Promise<Page<V1Appointment>> {
  const after = decodeCursor(cursor);
  const conditions: SQL[] = [eq(appointments.tenantId, tenantId)];
  if (filters.from) conditions.push(sql`${appointments.startsAt} >= ${filters.from}::timestamptz`);
  if (filters.to) conditions.push(sql`${appointments.startsAt} < ${filters.to}::timestamptz`);
  if (filters.status) conditions.push(eq(appointments.status, filters.status));
  if (filters.customerId) conditions.push(eq(appointments.patientId, filters.customerId));
  if (after) conditions.push(sql`(${appointments.startsAt}, ${appointments.id}) < (${after.t}::timestamptz, ${after.id})`);
  const rows = await withTenant(tenantId, (tx) => tx.select().from(appointments)
    .where(and(...conditions)).orderBy(desc(appointments.startsAt), desc(appointments.id)).limit(limit + 1));
  const page = pageOf(rows, limit, (row) => ({ t: row.startsAt.toISOString(), id: row.id }));
  return { items: page.items.map(toAppointment), nextCursor: page.nextCursor };
}

export async function readAppointment(transaction: KalendrTransaction, tenantId: string, appointmentId: string): Promise<AppointmentRow> {
  const [row] = await transaction.select().from(appointments)
    .where(and(eq(appointments.tenantId, tenantId), eq(appointments.id, appointmentId))).limit(1);
  if (!row) throw new ApiError(404, "appointment_not_found", "Appointment not found.");
  return row;
}

export async function getAppointment(tenantId: string, appointmentId: string): Promise<V1Appointment> {
  return toAppointment(await withTenant(tenantId, (tx) => readAppointment(tx, tenantId, appointmentId)));
}

export interface CustomerFilters {
  phone?: string;
  email?: string;
}

const customerSort = sql`date_trunc('milliseconds', ${patients.createdAt})`;

/** Newest first. A phone matches however it is written, using the same normalisation the booking pages use. */
export async function listCustomers(tenantId: string, filters: CustomerFilters, limit: number, cursor: string | undefined): Promise<Page<V1Customer>> {
  const after = decodeCursor(cursor);
  const conditions: SQL[] = [eq(patients.tenantId, tenantId), isNull(patients.erasedAt), isNull(patients.mergedIntoId)];
  if (filters.phone) conditions.push(sql`kalendr_normalize_phone(${patients.phone}) = kalendr_normalize_phone(${filters.phone})`);
  if (filters.email) conditions.push(sql`lower(${patients.email}) = ${filters.email.toLowerCase()}`);
  // Milliseconds are what the cursor can carry, so both sides of the comparison are cut to them.
  if (after) conditions.push(sql`(${customerSort}, ${patients.id}) < (${after.t}::timestamptz, ${after.id})`);
  const rows = await withTenant(tenantId, (tx) => tx.select().from(patients)
    .where(and(...conditions)).orderBy(desc(customerSort), desc(patients.id)).limit(limit + 1));
  const page = pageOf(rows, limit, (row) => ({ t: row.createdAt.toISOString(), id: row.id }));
  return { items: await withTags(tenantId, page.items.map(toCustomer)), nextCursor: page.nextCursor };
}

export async function getCustomer(tenantId: string, customerId: string): Promise<V1Customer> {
  const [row] = await withTenant(tenantId, (tx) => tx.select().from(patients)
    .where(and(eq(patients.tenantId, tenantId), eq(patients.id, customerId), isNull(patients.erasedAt), isNull(patients.mergedIntoId))).limit(1));
  if (!row) throw new ApiError(404, "customer_not_found", "Customer not found.");
  const [customer] = await withTags(tenantId, [toCustomer(row)]);
  return customer ?? toCustomer(row);
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;

/** A path id that cannot be one of ours is the same 404 as an id that is not found, never a database error. */
export function pathId(value: string | undefined, notFound: { code: string; message: string }): string {
  if (!value || !ID_PATTERN.test(value)) throw new ApiError(404, notFound.code, notFound.message);
  return value;
}
