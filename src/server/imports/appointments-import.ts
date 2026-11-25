import { createHash } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { runWithDatabase, withTenant } from "@/db/client";
import { schema } from "@/db/schema";
import { resolvePermissions } from "@/lib/permissions";
import { ApiError } from "@/server/api-error";
import { assertSlotOfferable } from "@/server/slot-engine/commit";
import { localInstant, MINUTE } from "@/server/slot-engine/time";
import type { StaffContext } from "@/server/staff-context";

import { applyMapping } from "./map";
import { outcome, type CheckState, type CommitResult, type CommitRow, type ImportContext, type KindImporter, type UndoRow } from "./kinds";
import type { ImportErrorCode } from "./contracts";
import type { RowOutcome, TenantDb } from "./job-db";
import { normaliseAppointment, type AppointmentValue, type Normalised } from "./validate";

/**
 * Future appointments. Customers, services and staff are matched by name, the booking is made by the very same code the
 * desk uses (createStaffAppointment, so the slot rules and the database's no-overlap guarantee both apply), and by
 * default no confirmation or reminder goes out. A check only looks: it never books.
 */

interface Catalog {
  services: Map<string, { id: string; durationMinutes: number }>;
  staff: Map<string, string>;
  /** The branch a service and a staff member share, with its time zone. The first shared branch when there are several. */
  places: Map<string, { locationId: string; timezone: string }>;
  clinicSlug: string;
  clinicName: string;
}

export interface Resolved {
  patientId: string;
  serviceId: string;
  practitionerId: string;
  locationId: string;
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
  explicitLength: boolean;
}

type Resolution = { ok: true; value: Resolved } | { ok: false; code: ImportErrorCode; field: string };

// The shared booking code expects the web app's drizzle database. Wrapping a postgres.js client with drizzle changes how
// that client reads and writes JSON, so the wrapper gets a small pool of its own and the worker's main connection is untouched.
const bookingDatabases = new Map<string, ReturnType<typeof drizzle<typeof schema>>>();

export function withWorkerDatabase<T>(databaseUrl: string, operation: () => Promise<T>): Promise<T> {
  let database = bookingDatabases.get(databaseUrl);
  if (!database) {
    database = drizzle(postgres(databaseUrl, { max: 3, prepare: false, idle_timeout: 20, transform: { undefined: null }, connection: { application_name: "kalendr-worker-import" } }), { schema });
    bookingDatabases.set(databaseUrl, database);
  }
  return runWithDatabase(database, operation);
}

async function loadCatalog(tenantDb: TenantDb, tenantId: string): Promise<Catalog> {
  const [tenant] = await tenantDb<{ slug: string; name: string }[]>`select slug, name from tenants where id = ${tenantId}`;
  const services = new Map<string, { id: string; durationMinutes: number }>();
  for (const row of await tenantDb<{ id: string; name: string; duration_minutes: number }[]>`
    select id, name, duration_minutes from services where tenant_id = ${tenantId} and is_active order by created_at, id`) {
    const key = row.name.trim().replace(/\s+/g, " ").toLowerCase();
    if (!services.has(key)) services.set(key, { id: row.id, durationMinutes: row.duration_minutes });
  }
  const staff = new Map<string, string>();
  for (const row of await tenantDb<{ id: string; name: string }[]>`
    select id, name from practitioners where tenant_id = ${tenantId} and is_active order by created_at, id`) {
    const key = row.name.replace(/\./g, " ").trim().replace(/\s+/g, " ").toLowerCase().replace(/^(dr|mr|mrs|ms|prof)\s+/, "");
    if (!staff.has(key)) staff.set(key, row.id);
  }
  const places = new Map<string, { locationId: string; timezone: string }>();
  for (const row of await tenantDb<{ service_id: string; practitioner_id: string; location_id: string; timezone: string }[]>`
    select service_location.service_id, practitioner_location.practitioner_id, location.id as location_id, location.timezone
    from service_locations as service_location
    join practitioner_locations as practitioner_location
      on practitioner_location.tenant_id = service_location.tenant_id and practitioner_location.location_id = service_location.location_id
    join practitioner_services as practitioner_service
      on practitioner_service.tenant_id = service_location.tenant_id and practitioner_service.service_id = service_location.service_id
      and practitioner_service.practitioner_id = practitioner_location.practitioner_id
    join locations as location on location.tenant_id = service_location.tenant_id and location.id = service_location.location_id and location.is_active
    where service_location.tenant_id = ${tenantId}
    order by location.created_at, location.id`) {
    const key = `${row.service_id}:${row.practitioner_id}`;
    if (!places.has(key)) places.set(key, { locationId: row.location_id, timezone: row.timezone });
  }
  return { services, staff, places, clinicSlug: tenant?.slug ?? "", clinicName: tenant?.name ?? "" };
}

async function findCustomer(tenantDb: TenantDb, tenantId: string, value: AppointmentValue): Promise<string | null> {
  const [row] = await tenantDb<{ id: string }[]>`
    select id from patients
    where tenant_id = ${tenantId} and erased_at is null
      and ((${value.customerPhoneKey} <> '' and kalendr_normalize_phone(phone) = ${value.customerPhoneKey})
        or (${value.customerEmail} <> '' and email <> '' and lower(trim(email)) = ${value.customerEmail}))
    order by (kalendr_normalize_phone(phone) = ${value.customerPhoneKey}) desc, created_at, id
    limit 1`;
  return row?.id ?? null;
}

async function resolve(context: ImportContext, catalog: Catalog, value: AppointmentValue): Promise<Resolution> {
  const patientId = await findCustomer(context.tenantDb, context.tenantId, value);
  if (!patientId) return { ok: false, code: "unknown_customer", field: value.customerPhoneKey ? "customerPhone" : "customerEmail" };
  const service = catalog.services.get(value.serviceKey);
  if (!service) return { ok: false, code: "unknown_service", field: "service" };
  const practitionerId = catalog.staff.get(value.staffKey);
  if (!practitionerId) return { ok: false, code: "unknown_staff", field: "staff" };
  const place = catalog.places.get(`${service.id}:${practitionerId}`);
  if (!place) return { ok: false, code: "no_location", field: "staff" };
  const startsAt = new Date(localInstant(value.date, value.time, place.timezone));
  const durationMinutes = value.durationMinutes ?? service.durationMinutes;
  if (startsAt.getTime() <= Date.now()) return { ok: false, code: "past_time", field: "startsAt" };
  return {
    ok: true,
    value: {
      patientId, serviceId: service.id, practitionerId, locationId: place.locationId, startsAt,
      endsAt: new Date(startsAt.getTime() + durationMinutes * MINUTE), durationMinutes, explicitLength: value.durationMinutes !== null,
    },
  };
}

const normaliseRow = (context: ImportContext, rowNumber: number): Normalised<AppointmentValue> =>
  normaliseAppointment(applyMapping(context.file.rows[rowNumber - 1] ?? [], context.mapping, "appointments"), context.settings);

function slotCode(error: unknown): ImportErrorCode {
  if (error instanceof ApiError) {
    if (error.code === "limit_reached") return "limit_reached";
    if (error.code === "slot_unavailable") return "slot_unavailable";
    if (error.code === "forbidden") return "forbidden";
  }
  return "row_failed";
}

async function check(context: ImportContext, start: number, end: number, state: CheckState): Promise<RowOutcome[]> {
  if (!context.databaseUrl) throw new Error("database_unavailable");
  const catalog = await loadCatalog(context.tenantDb, context.tenantId);
  const outcomes: RowOutcome[] = [];
  await withWorkerDatabase(context.databaseUrl, () => withTenant(context.tenantId, async (transaction) => {
    for (let rowNumber = start + 1; rowNumber <= end; rowNumber += 1) {
      const normalised = normaliseRow(context, rowNumber);
      if (!normalised.ok) {
        outcomes.push(outcome(rowNumber, "error", normalised.issue.code, normalised.issue.field));
        continue;
      }
      const resolved = await resolve(context, catalog, normalised.value);
      if (!resolved.ok) {
        outcomes.push(outcome(rowNumber, "error", resolved.code, resolved.field));
        continue;
      }
      const row = resolved.value;
      const [same] = await context.tenantDb<{ id: string }[]>`
        select id from appointments
        where tenant_id = ${context.tenantId} and patient_id = ${row.patientId} and practitioner_id = ${row.practitionerId}
          and starts_at = ${row.startsAt.toISOString()}::timestamptz and status in ('requested', 'booked', 'checked_in')
        limit 1`;
      if (same) {
        outcomes.push(outcome(rowNumber, "will_skip", "duplicate_existing", "startsAt", same.id));
        continue;
      }
      const span: [number, number] = [row.startsAt.getTime(), row.endsAt.getTime()];
      const placed = state.booked.get(row.practitionerId) ?? [];
      if (placed.some(([from, to]) => span[0] < to && span[1] > from)) {
        outcomes.push(outcome(rowNumber, "error", "clash", "startsAt"));
        continue;
      }
      const [overlap] = await context.tenantDb<{ id: string }[]>`
        select id from appointments
        where tenant_id = ${context.tenantId} and practitioner_id = ${row.practitionerId}
          and status in ('requested', 'booked', 'checked_in') and starts_at < ${row.endsAt.toISOString()}::timestamptz and ends_at > ${row.startsAt.toISOString()}::timestamptz
        limit 1`;
      if (overlap) {
        outcomes.push(outcome(rowNumber, "error", "clash", "startsAt"));
        continue;
      }
      try {
        await assertSlotOfferable(transaction, {
          tenantId: context.tenantId, locationId: row.locationId, serviceId: row.serviceId, practitionerId: row.practitionerId,
          startsAt: row.startsAt, endsAt: row.endsAt, mode: "standard",
        });
      } catch (error) {
        outcomes.push(outcome(rowNumber, "error", slotCode(error), "startsAt"));
        continue;
      }
      placed.push(span);
      state.booked.set(row.practitionerId, placed);
      outcomes.push(outcome(rowNumber, "ready"));
    }
  }));
  return outcomes;
}

/** The staff-shaped identity the shared booking code expects: the person who started the import, as an administrator. */
function importerContext(context: ImportContext, catalog: Catalog): StaffContext | null {
  const userId = context.job.started_by_user_id;
  if (!userId) return null;
  return {
    tenantId: context.tenantId, clinicSlug: catalog.clinicSlug, clinicName: catalog.clinicName, role: "admin",
    permissions: resolvePermissions("admin", {}), membershipId: null, userId, userName: "Import", userEmail: "",
    secondFactorEnrolled: false, secondFactorAt: null, preview: false,
  };
}

// The shared booking code opens its own connection, and the batch already holds one. One appointment batch at a time
// per worker keeps those second connections from ever running the pool dry.
let lane: Promise<unknown> = Promise.resolve();
function inLane<T>(work: () => Promise<T>): Promise<T> {
  const next = lane.then(work, work);
  lane = next.catch(() => undefined);
  return next;
}

async function commit(context: ImportContext, rows: readonly CommitRow[]): Promise<CommitResult[]> {
  const databaseUrl = context.databaseUrl;
  if (!databaseUrl) throw new Error("database_unavailable");
  return inLane(async () => {
    const { createStaffAppointment } = await import("@/server/appointment-repository");
    const catalog = await loadCatalog(context.tenantDb, context.tenantId);
    const staff = importerContext(context, catalog);
    const results: CommitResult[] = [];
    for (const row of rows) {
      const done = (status: CommitResult["status"], code: CommitResult["code"] = null, field: string | null = null, entityId: string | null = null) =>
        results.push({ rowNumber: row.rowNumber, status, code, field, entityId });
      const normalised = normaliseRow(context, row.rowNumber);
      if (!normalised.ok) {
        done("failed", normalised.issue.code, normalised.issue.field);
        continue;
      }
      const resolved = await resolve(context, catalog, normalised.value);
      if (!resolved.ok) {
        done("failed", resolved.code, resolved.field);
        continue;
      }
      if (!staff) {
        done("failed", "forbidden");
        continue;
      }
      const value = resolved.value;
      const input = {
        clinicSlug: catalog.clinicSlug, locationId: value.locationId, serviceId: value.serviceId, practitionerId: value.practitionerId,
        startsAt: value.startsAt.toISOString(), source: "desk" as const, patientId: value.patientId,
        ...(value.explicitLength ? { durationMinutes: value.durationMinutes } : {}),
        // No confirmation and no reminder unless the owner asked for them.
        ...(context.options.sendConfirmations ? {} : { notifyCustomer: false }),
      };
      try {
        // The same key and request make a replayed batch return the booking it already made.
        const booked = await withWorkerDatabase(databaseUrl, () => createStaffAppointment(
          staff, input, `import:${context.job.id}:${row.rowNumber}`, createHash("sha256").update(JSON.stringify(input)).digest("hex"),
        ));
        done("created", null, null, booked.appointmentId);
      } catch (error) {
        done("failed", slotCode(error), "startsAt");
      }
    }
    return results;
  });
}

async function undo(context: ImportContext, rows: readonly UndoRow[]): Promise<Array<{ rowNumber: number; outcome: "removed" | "kept" }>> {
  const databaseUrl = context.databaseUrl;
  const userId = context.job.started_by_user_id;
  if (!databaseUrl) throw new Error("database_unavailable");
  return inLane(async () => {
    const { updateAppointmentStatus } = await import("@/server/appointment-repository");
    const results: Array<{ rowNumber: number; outcome: "removed" | "kept" }> = [];
    for (const row of rows) {
      const [current] = await context.tenantDb<{ status: string; version: number }[]>`
        select status, version from appointments where tenant_id = ${context.tenantId} and id = ${row.entityId}`;
      if (!current) {
        results.push({ rowNumber: row.rowNumber, outcome: "removed" });
        continue;
      }
      // Only a booking nobody has touched: still booked or requested, and never edited (the version counts every edit).
      if (!userId || current.version !== 1 || (current.status !== "booked" && current.status !== "requested")) {
        results.push({ rowNumber: row.rowNumber, outcome: "kept" });
        continue;
      }
      try {
        await withWorkerDatabase(databaseUrl, () => updateAppointmentStatus(
          userId, row.entityId, { status: "cancelled", expectedVersion: 1 }, undefined, { quiet: !context.options.sendConfirmations },
        ));
        results.push({ rowNumber: row.rowNumber, outcome: "removed" });
      } catch {
        results.push({ rowNumber: row.rowNumber, outcome: "kept" });
      }
    }
    return results;
  });
}

export const appointmentImporter: KindImporter = { check, commit, undo };
