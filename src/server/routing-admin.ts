import "server-only";

import { sql } from "drizzle-orm";

import { getDatabase, withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents } from "@/db/schema";
import type { LeaveBookingsView, LeaveReassignInput, LeaveReassignResult, ServiceRoutingInput, ServiceRoutingView, TeamShareView } from "@/lib/routing-contracts";
import { ApiError } from "@/server/api-error";
import { withLockedStaffAppointment } from "@/server/appointment-tx";
import { versionConflict } from "@/server/appointment-repository";
import { claimKey, finishKey } from "@/server/idempotent";
import { requirePermission, type StaffContext } from "@/server/staff-context";
import { assertSlotOfferable } from "@/server/slot-engine/commit";
import { reassignIn } from "@/server/visit-actions";

/**
 * The owner's side of team routing (feature 20): how a service gives out "anyone" bookings, how fair the month has been,
 * and moving a team member's bookings to their cover person when they take leave.
 */

function requireDatabase(context: StaffContext): void {
  if (context.preview || !getDatabase()) throw new ApiError(503, "database_unavailable", "Team routing needs the live database.");
}

export async function getServiceRouting(context: StaffContext, serviceId: string): Promise<ServiceRoutingView> {
  requirePermission(context, "settings.manage");
  requireDatabase(context);
  return withTenant(context.tenantId, async (transaction) => {
    const [service] = await transaction.execute<{ name: string; version: number; assignment: ServiceRoutingView["assignment"]; prefer_returning_person: boolean }>(sql`
      select name, version, assignment, prefer_returning_person from services where tenant_id = ${context.tenantId} and id = ${serviceId}
    `);
    if (!service) throw new ApiError(404, "service_not_found", "Service not found.");
    const people = await transaction.execute<{ practitioner_id: string; name: string; priority: number; weight: number }>(sql`
      select practitioner_service.practitioner_id, practitioner.name, practitioner_service.priority, practitioner_service.weight
      from practitioner_services as practitioner_service
      join practitioners as practitioner on practitioner.tenant_id = practitioner_service.tenant_id and practitioner.id = practitioner_service.practitioner_id
      where practitioner_service.tenant_id = ${context.tenantId} and practitioner_service.service_id = ${serviceId} and practitioner.is_active
      order by practitioner_service.priority desc, practitioner.name
    `);
    return {
      serviceId,
      serviceName: service.name,
      version: Number(service.version),
      assignment: service.assignment,
      preferReturningPerson: service.prefer_returning_person,
      people: people.map((row) => ({ practitionerId: row.practitioner_id, name: row.name, priority: Number(row.priority), weight: Number(row.weight) })),
    };
  });
}

export async function saveServiceRouting(context: StaffContext, serviceId: string, input: ServiceRoutingInput): Promise<ServiceRoutingView> {
  requirePermission(context, "settings.manage");
  requireDatabase(context);
  await withTenant(context.tenantId, async (transaction) => {
    const [service] = await transaction.execute<{ version: number }>(sql`
      select version from services where tenant_id = ${context.tenantId} and id = ${serviceId} for update
    `);
    if (!service) throw new ApiError(404, "service_not_found", "Service not found.");
    if (Number(service.version) !== input.expectedVersion) throw versionConflict();
    const seen = new Set<string>();
    for (const person of input.people) {
      if (seen.has(person.practitionerId)) throw new ApiError(400, "validation_error", "Each person can appear once.");
      seen.add(person.practitionerId);
      const updated = await transaction.execute<{ practitioner_id: string }>(sql`
        update practitioner_services set priority = ${person.priority}, weight = ${person.weight}
        where tenant_id = ${context.tenantId} and service_id = ${serviceId} and practitioner_id = ${person.practitionerId}
        returning practitioner_id
      `);
      if (updated.length === 0) throw new ApiError(400, "validation_error", "Choose people who offer this service.");
    }
    await transaction.execute(sql`
      update services set assignment = ${input.assignment}, prefer_returning_person = ${input.preferReturningPerson},
        version = version + 1, updated_at = now()
      where tenant_id = ${context.tenantId} and id = ${serviceId}
    `);
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId ?? null, actorType: "staff", action: "routing.service.updated", outcome: "success",
      metadata: { serviceId, assignment: input.assignment, preferReturningPerson: input.preferReturningPerson, people: input.people.length },
    });
  });
  return getServiceRouting(context, serviceId);
}

/** Each active person's bookings that start in the month, against the share their weights say they should take. */
export async function getTeamShare(context: StaffContext, month: string): Promise<TeamShareView> {
  requirePermission(context, "schedule.read");
  requireDatabase(context);
  const start = new Date(`${month}-01T00:00:00.000Z`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return withTenant(context.tenantId, async (transaction) => {
    // The month is read in UTC on purpose: it is a fairness figure, not a calendar, and a day's drift moves nobody's share.
    const rows = await transaction.execute<{ practitioner_id: string; name: string; bookings: number | string; weight: number | string }>(sql`
      select practitioner.id as practitioner_id, practitioner.name,
        (select count(*) from appointments as appointment
          where appointment.tenant_id = practitioner.tenant_id and appointment.practitioner_id = practitioner.id
            and appointment.starts_at >= ${start.toISOString()}::timestamptz and appointment.starts_at < ${end.toISOString()}::timestamptz
            and appointment.status in ('booked', 'checked_in', 'completed', 'requested', 'pending_payment')) as bookings,
        coalesce((select max(practitioner_service.weight) from practitioner_services as practitioner_service
          where practitioner_service.tenant_id = practitioner.tenant_id and practitioner_service.practitioner_id = practitioner.id), 1) as weight
      from practitioners as practitioner
      where practitioner.tenant_id = ${context.tenantId} and practitioner.is_active
      order by practitioner.name
    `);
    const total = rows.reduce((sum, row) => sum + Number(row.bookings), 0);
    const weights = rows.reduce((sum, row) => sum + Number(row.weight), 0);
    return {
      month,
      total,
      people: rows.map((row) => ({
        practitionerId: row.practitioner_id,
        name: row.name,
        bookings: Number(row.bookings),
        sharePercent: total === 0 ? 0 : Math.round((Number(row.bookings) / total) * 100),
        weightPercent: weights === 0 ? 0 : Math.round((Number(row.weight) / weights) * 100),
      })),
    };
  });
}

interface LeaveRow extends Record<string, unknown> {
  id: string;
  practitioner_id: string;
  cover_practitioner_id: string | null;
  starts_at: Date | string;
  ends_at: Date | string;
}

async function loadLeave(transaction: KalendrTransaction, tenantId: string, timeOffId: string): Promise<LeaveRow> {
  const [leave] = await transaction.execute<LeaveRow>(sql`
    select id, practitioner_id, cover_practitioner_id, starts_at, ends_at from time_off where tenant_id = ${tenantId} and id = ${timeOffId}
  `);
  if (!leave) throw new ApiError(404, "time_off_not_found", "That time off was not found.");
  return leave;
}

interface AffectedRow extends Record<string, unknown> {
  id: string;
  version: number;
  starts_at: Date | string;
  ends_at: Date | string;
  location_id: string;
  service_id: string;
  service_name: string;
  first_name: string;
  last_name: string;
}

/** The person's live bookings that fall inside the time off. These are the ones to move; any left with them are "Needs a person". */
async function affectedBookings(transaction: KalendrTransaction, tenantId: string, leave: LeaveRow): Promise<AffectedRow[]> {
  return transaction.execute<AffectedRow>(sql`
    select appointment.id, appointment.version, appointment.starts_at, appointment.ends_at, appointment.location_id, appointment.service_id,
      service.name as service_name, patient.first_name, patient.last_name
    from appointments as appointment
    join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
    join patients as patient on patient.tenant_id = appointment.tenant_id and patient.id = appointment.patient_id
    where appointment.tenant_id = ${tenantId} and appointment.practitioner_id = ${leave.practitioner_id}
      and appointment.status in ('requested', 'booked')
      and appointment.starts_at < ${new Date(leave.ends_at).toISOString()}::timestamptz and appointment.ends_at > ${new Date(leave.starts_at).toISOString()}::timestamptz
      and appointment.ends_at > now()
    order by appointment.starts_at
    limit 300
  `);
}

export async function listLeaveBookings(context: StaffContext, timeOffId: string): Promise<LeaveBookingsView> {
  requirePermission(context, "appointments.book");
  requireDatabase(context);
  return withTenant(context.tenantId, async (transaction) => {
    const leave = await loadLeave(transaction, context.tenantId, timeOffId);
    const rows = await affectedBookings(transaction, context.tenantId, leave);
    let coverName: string | null = null;
    if (leave.cover_practitioner_id) {
      const [cover] = await transaction.execute<{ name: string }>(sql`select name from practitioners where tenant_id = ${context.tenantId} and id = ${leave.cover_practitioner_id}`);
      coverName = cover?.name ?? null;
    }
    const bookings = [];
    for (const row of rows) {
      let coverFree: boolean | null = null;
      if (leave.cover_practitioner_id) {
        // A read-only check: the same rules the move itself will apply, rolled back so it changes nothing.
        coverFree = await isFreeFor(transaction, context.tenantId, row, leave.cover_practitioner_id);
      }
      bookings.push({
        appointmentId: row.id,
        version: Number(row.version),
        startsAt: new Date(row.starts_at).toISOString(),
        endsAt: new Date(row.ends_at).toISOString(),
        serviceName: row.service_name,
        customerName: `${row.first_name} ${row.last_name}`.trim(),
        coverFree,
      });
    }
    return { timeOffId, practitionerId: leave.practitioner_id, coverPractitionerId: leave.cover_practitioner_id, coverName, bookings };
  });
}

async function isFreeFor(transaction: KalendrTransaction, tenantId: string, row: AffectedRow, practitionerId: string): Promise<boolean> {
  try {
    await assertSlotOfferable(transaction, {
      tenantId, locationId: row.location_id, serviceId: row.service_id, practitionerId,
      startsAt: new Date(row.starts_at), endsAt: new Date(row.ends_at), mode: "existing", excludeAppointmentId: row.id, keepExistingLength: true,
    });
    return true;
  } catch (error) {
    if (error instanceof ApiError) return false;
    throw error;
  }
}

/**
 * Moves a person's bookings inside a time off to their cover person, one booking at a time through the same
 * reassign the bookings list uses (same booking, time and manage link; version checked; the customer is told who it is now).
 * Those the cover is not free for stay where they are and come back as "needs a person".
 */
export async function reassignLeaveBookings(context: StaffContext, input: LeaveReassignInput, idempotencyKey: string): Promise<LeaveReassignResult> {
  requirePermission(context, "appointments.book");
  requireDatabase(context);
  const route = "/api/staff/routing/leave-reassign";
  const claim = await withTenant(context.tenantId, (transaction) => claimKey<LeaveReassignResult>(transaction, context.tenantId, route, idempotencyKey, input));
  if ("replay" in claim) return claim.replay;

  const { leave, rows } = await withTenant(context.tenantId, async (transaction) => {
    const loaded = await loadLeave(transaction, context.tenantId, input.timeOffId);
    return { leave: loaded, rows: await affectedBookings(transaction, context.tenantId, loaded) };
  });
  const target = input.toPractitionerId ?? leave.cover_practitioner_id;
  if (!target) throw new ApiError(400, "cover_required", "Choose who covers these bookings first.");
  if (target === leave.practitioner_id) throw new ApiError(400, "validation_error", "Choose someone other than the person who is away.");
  const only = input.appointmentIds ? new Set(input.appointmentIds) : null;
  const actor = { type: "staff" as const, ...(context.userId ? { userId: context.userId } : {}) };

  let moved = 0;
  const needsPerson: LeaveReassignResult["needsPerson"] = [];
  for (const row of rows) {
    if (only && !only.has(row.id)) continue;
    try {
      await withLockedStaffAppointment(context, row.id, Number(row.version), (transaction, current) =>
        reassignIn(transaction, current, actor, { practitionerId: target }));
      moved += 1;
    } catch (error) {
      needsPerson.push({ appointmentId: row.id, reason: error instanceof ApiError ? error.message : "Something went wrong with this one. Try it on its own." });
    }
  }
  const result = { moved, needsPerson };
  await withTenant(context.tenantId, async (transaction) => {
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId ?? null, actorType: "staff", action: "routing.leave.reassigned", outcome: "success",
      metadata: { timeOffId: input.timeOffId, toPractitionerId: target, moved, needsPerson: needsPerson.length },
    });
    await finishKey(transaction, claim.claimId, result);
  });
  return result;
}
