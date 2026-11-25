import "server-only";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { getDatabase, withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents } from "@/db/schema";
import {
  MAX_TIMETABLE_SESSIONS,
  type ClassTypeInput, type CreateSessionsInput, type CreateSessionsResult, type EnrolInput, type EnrolResult, type EnrolmentStatus,
  type RosterEntry, type SessionDetail, type SessionStatus, type SessionView, type TimetableSession,
} from "@/lib/classes-contracts";
import { joinFullName } from "@/features/booking/full-name";
import { expandRuleDates } from "@/lib/series-rule";
import { ApiError, getPostgresErrorCode } from "@/server/api-error";
import { createOpaqueToken, sha256 } from "@/server/crypto";
import { claimKey, finishKey } from "@/server/idempotent";
import { sealPrivate } from "@/server/messaging/sealed-link";
import { assertSlotOfferable } from "@/server/slot-engine/commit";
import { localInstant, MINUTE } from "@/server/slot-engine/time";
import { andLocation, assertLocationAllowed, canUseLocation } from "@/server/location-scope";
import { requirePermission, type StaffContext } from "@/server/staff-context";
import { notifyStaff } from "@/server/staff-notifications";
import { assertTenantNotPaused } from "@/server/tenant-pause";
import { drizzleRunner } from "@/server/workflows/runner";

import { lockSession, offerFreeSeats, queueNotice, seatsHeld, SEAT_SEAL_PURPOSE, waitPosition, type SessionRow } from "./class-seats";

/**
 * Group sessions and classes (feature 18). A class is a service with a capacity; a session is one dated occurrence of
 * it. A session holds its teacher (and room) in the same overlap-proof reservations a one-to-one booking uses, so a
 * teacher cannot be double-booked between a class and a visit.
 */

const unavailable = (): ApiError => new ApiError(503, "database_unavailable", "Classes need the live database.");

function requireDatabase(context: { preview?: boolean }): void {
  if (context.preview || !getDatabase()) throw unavailable();
}

function manage(context: StaffContext): void {
  requirePermission(context, "classes.manage");
  requireDatabase(context);
}

async function audit(transaction: KalendrTransaction, context: StaffContext, action: string, metadata: Record<string, string | number | boolean | null>): Promise<void> {
  await transaction.insert(auditEvents).values({ tenantId: context.tenantId, actorUserId: context.userId ?? null, actorType: "staff", action, outcome: "success", metadata });
}

/* ---------- Class types ---------- */

export async function createClassType(context: StaffContext, input: ClassTypeInput): Promise<{ serviceId: string }> {
  manage(context);
  return withTenant(context.tenantId, async (transaction) => {
    const places = await transaction.execute<{ id: string }>(sql`
      select id from locations where tenant_id = ${context.tenantId} and id in (${sql.join(input.locationIds.map((id) => sql`${id}`), sql`, `)})`);
    const people = await transaction.execute<{ id: string }>(sql`
      select id from practitioners where tenant_id = ${context.tenantId} and id in (${sql.join(input.practitionerIds.map((id) => sql`${id}`), sql`, `)})`);
    if (places.length !== new Set(input.locationIds).size || people.length !== new Set(input.practitionerIds).size) {
      throw new ApiError(400, "validation_error", "Choose places and teachers that belong to this business.");
    }
    const [service] = await transaction.execute<{ id: string }>(sql`
      insert into services (tenant_id, name, description, duration_minutes, booking_mode, patient_types, price_minor, required_resource_kind, kind, capacity,
        minimum_lead_minutes, slot_interval_minutes)
      values (${context.tenantId}, ${input.name}, ${input.description}, ${input.durationMinutes}, 'instant', ${sql`ARRAY['new','returning']::text[]`},
        ${input.priceMinor}, ${input.requiredResourceKind}, 'class', ${input.capacity}, 60, ${input.durationMinutes})
      returning id`);
    const serviceId = service!.id;
    for (const locationId of new Set(input.locationIds)) {
      await transaction.execute(sql`insert into service_locations (tenant_id, service_id, location_id) values (${context.tenantId}, ${serviceId}, ${locationId})`);
    }
    for (const practitionerId of new Set(input.practitionerIds)) {
      await transaction.execute(sql`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${context.tenantId}, ${practitionerId}, ${serviceId})`);
      // A teacher may also teach where they are not yet listed; the class's places decide where sessions can run.
      for (const locationId of new Set(input.locationIds)) {
        await transaction.execute(sql`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${context.tenantId}, ${practitionerId}, ${locationId}) on conflict do nothing`);
      }
    }
    await audit(transaction, context, "class.type.created", { serviceId, capacity: input.capacity });
    return { serviceId };
  });
}

export interface ClassTypeView {
  serviceId: string;
  name: string;
  durationMinutes: number;
  capacity: number;
  locationIds: string[];
  practitionerIds: string[];
  priceMinor: number | null;
}

/** The active classes, with the places and teachers each runs with, for the "New session" form. */
export async function listClassTypes(context: StaffContext): Promise<ClassTypeView[]> {
  requirePermission(context, "schedule.read");
  requireDatabase(context);
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.execute<{ id: string; name: string; duration_minutes: number; capacity: number | null; price_minor: number | null; location_ids: string[] | null; practitioner_ids: string[] | null }>(sql`
      select service.id, service.name, service.duration_minutes, service.capacity, service.price_minor,
        array(select sl.location_id from service_locations as sl where sl.tenant_id = service.tenant_id and sl.service_id = service.id) as location_ids,
        array(select ps.practitioner_id from practitioner_services as ps where ps.tenant_id = service.tenant_id and ps.service_id = service.id) as practitioner_ids
      from services as service
      where service.tenant_id = ${context.tenantId} and service.kind = 'class' and service.is_active
      order by service.name, service.id`);
    return rows.map((row) => ({
      serviceId: row.id, name: row.name, durationMinutes: Number(row.duration_minutes), capacity: Number(row.capacity ?? 1),
      locationIds: row.location_ids ?? [], practitionerIds: row.practitioner_ids ?? [], priceMinor: row.price_minor === null ? null : Number(row.price_minor),
    }));
  });
}

/* ---------- Sessions (staff) ---------- */

interface SessionSqlRow extends Record<string, unknown> {
  id: string; version: number; service_id: string; service_name: string; practitioner_id: string; teacher_name: string; location_id: string;
  starts_at: Date | string; ends_at: Date | string; capacity: number; status: SessionStatus; series_id: string | null; taken: number | string; waiting: number | string;
}

const sessionSelect = (tenantId: string) => sql`
  select session.id, session.version, session.service_id, service.name as service_name, session.practitioner_id, teacher.name as teacher_name,
    session.location_id, session.starts_at, session.ends_at, session.capacity, session.status, session.series_id,
    (select count(*) from class_enrolments as e where e.tenant_id = session.tenant_id and e.session_id = session.id
      and (e.status in ('booked', 'attended', 'no_show') or (e.status = 'waitlisted' and e.offer_expires_at is not null and e.offer_expires_at > now()))) as taken,
    (select count(*) from class_enrolments as e where e.tenant_id = session.tenant_id and e.session_id = session.id and e.status = 'waitlisted') as waiting
  from class_sessions as session
  join services as service on service.tenant_id = session.tenant_id and service.id = session.service_id
  join practitioners as teacher on teacher.tenant_id = session.tenant_id and teacher.id = session.practitioner_id
  where session.tenant_id = ${tenantId}`;

function toView(row: SessionSqlRow): SessionView {
  return {
    id: row.id, version: Number(row.version), serviceId: row.service_id, serviceName: row.service_name, teacherId: row.practitioner_id, teacherName: row.teacher_name,
    locationId: row.location_id, startsAt: new Date(row.starts_at).toISOString(), endsAt: new Date(row.ends_at).toISOString(), capacity: Number(row.capacity),
    status: row.status, seatsTaken: Number(row.taken), waiting: Number(row.waiting), seriesId: row.series_id,
  };
}

/** A practitioner sees the sessions they teach, and so only those rosters; everyone else sees the business's sessions. */
async function ownSessionClause(transaction: KalendrTransaction, context: StaffContext) {
  const atMyLocations = andLocation(context, sql`session.location_id`);
  if (context.role !== "practitioner") return atMyLocations;
  const [own] = await transaction.execute<{ id: string }>(sql`select id from practitioners where tenant_id = ${context.tenantId} and auth_user_id = ${context.userId} limit 1`);
  return own ? sql`and session.practitioner_id = ${own.id} ${atMyLocations}` : sql`and false`;
}

export async function listSessions(context: StaffContext, range: { from: Date; to: Date; serviceId?: string }): Promise<SessionView[]> {
  requirePermission(context, "schedule.read");
  requireDatabase(context);
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.execute<SessionSqlRow>(sql`
      ${sessionSelect(context.tenantId)}
      ${await ownSessionClause(transaction, context)}
      and session.starts_at >= ${range.from.toISOString()}::timestamptz and session.starts_at < ${range.to.toISOString()}::timestamptz
      ${range.serviceId ? sql`and session.service_id = ${range.serviceId}` : sql``}
      order by session.starts_at, session.id limit 500`);
    return rows.map(toView);
  });
}

export async function getSession(context: StaffContext, sessionId: string): Promise<SessionDetail> {
  requirePermission(context, "schedule.read");
  requireDatabase(context);
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.execute<SessionSqlRow>(sql`${sessionSelect(context.tenantId)} and session.id = ${sessionId} ${await ownSessionClause(transaction, context)}`);
    if (!row) throw new ApiError(404, "session_not_found", "That session was not found.");
    return { ...toView(row), roster: await rosterOf(transaction, context.tenantId, sessionId) };
  });
}

async function rosterOf(transaction: KalendrTransaction, tenantId: string, sessionId: string): Promise<RosterEntry[]> {
  const rows = await transaction.execute<{ id: string; version: number; patient_id: string; first_name: string; last_name: string; status: EnrolmentStatus; offer_expires_at: Date | string | null; source: RosterEntry["source"]; position: number | string | null }>(sql`
    select e.id, e.version, e.patient_id, patient.first_name, patient.last_name, e.status, e.offer_expires_at, e.source,
      case when e.status = 'waitlisted' then row_number() over (partition by e.status order by e.created_at, e.id) end as position
    from class_enrolments as e
    join patients as patient on patient.tenant_id = e.tenant_id and patient.id = e.patient_id
    where e.tenant_id = ${tenantId} and e.session_id = ${sessionId} and e.status <> 'cancelled'
    order by case e.status when 'attended' then 1 when 'booked' then 1 when 'no_show' then 1 else 2 end, e.created_at, e.id`);
  return rows.map((row) => ({
    enrolmentId: row.id, version: Number(row.version), patientId: row.patient_id, name: `${row.first_name} ${row.last_name}`.trim(), status: row.status,
    offerExpiresAt: row.offer_expires_at ? new Date(row.offer_expires_at).toISOString() : null, source: row.source, position: row.position === null ? null : Number(row.position),
  }));
}

/** One session, or a whole repeating timetable. Nothing is created when any date clashes, and each clash comes back with its reason. */
export async function createSessions(context: StaffContext, input: CreateSessionsInput): Promise<CreateSessionsResult> {
  manage(context);
  assertLocationAllowed(context, input.locationId);
  return withTenant(context.tenantId, async (transaction) => {
    const [service] = await transaction.execute<{ duration_minutes: number; capacity: number | null; kind: string; required_resource_kind: string | null }>(sql`
      select duration_minutes, capacity, kind, required_resource_kind from services where tenant_id = ${context.tenantId} and id = ${input.serviceId} and is_active`);
    if (!service || service.kind !== "class") throw new ApiError(404, "class_not_found", "That class was not found.");
    const [place] = await transaction.execute<{ timezone: string }>(sql`select timezone from locations where tenant_id = ${context.tenantId} and id = ${input.locationId} and is_active`);
    if (!place) throw new ApiError(404, "location_not_found", "That place was not found.");
    const [teacher] = await transaction.execute<{ id: string }>(sql`
      select practitioner.id from practitioners as practitioner
      join practitioner_services as link on link.tenant_id = practitioner.tenant_id and link.practitioner_id = practitioner.id and link.service_id = ${input.serviceId}
      join practitioner_locations as place on place.tenant_id = practitioner.tenant_id and place.practitioner_id = practitioner.id and place.location_id = ${input.locationId}
      where practitioner.tenant_id = ${context.tenantId} and practitioner.id = ${input.practitionerId} and practitioner.is_active
      for update of practitioner`);
    if (!teacher) throw new ApiError(400, "validation_error", "That person does not teach this class here.");

    const dates = input.repeat ? expandRuleDates(input.repeat, input.date).dates.map((entry) => entry.date) : [input.date];
    if (dates.length === 0 || dates.length > MAX_TIMETABLE_SESSIONS) throw new ApiError(400, "validation_error", `A timetable can have up to ${MAX_TIMETABLE_SESSIONS} sessions.`);
    const capacity = input.capacity ?? service.capacity ?? 1;
    const seriesId = input.repeat ? randomUUID() : null;
    const planned = dates.map((date) => {
      const startsAt = new Date(localInstant(date, input.time, place.timezone));
      return { date, startsAt, endsAt: new Date(startsAt.getTime() + service.duration_minutes * MINUTE) };
    });

    // Check every date with the same rules a booking uses (hours, time off, holidays, other visits and classes) before saving any.
    const clashes: CreateSessionsResult["clashes"] = [];
    const rooms = new Map<string, string | null>();
    for (const entry of planned) {
      try {
        const slot = await assertSlotOfferable(transaction, {
          tenantId: context.tenantId, locationId: input.locationId, serviceId: input.serviceId, practitionerId: input.practitionerId,
          startsAt: entry.startsAt, endsAt: entry.endsAt, mode: "existing", keepExistingLength: true,
        });
        rooms.set(entry.date, slot.resourceId);
      } catch (error) {
        if (error instanceof ApiError && (error.code === "slot_unavailable" || error.code === "limit_reached")) clashes.push({ date: entry.date, reason: error.message });
        else throw error;
      }
    }
    if (clashes.length > 0) return { created: 0, sessionIds: [], seriesId: null, clashes };

    const sessionIds: string[] = [];
    try {
      for (const entry of planned) {
        const resourceId = rooms.get(entry.date) ?? null;
        const [row] = await transaction.execute<{ id: string }>(sql`
          insert into class_sessions (tenant_id, service_id, practitioner_id, location_id, resource_id, starts_at, ends_at, capacity, series_id)
          values (${context.tenantId}, ${input.serviceId}, ${input.practitionerId}, ${input.locationId}, ${resourceId},
            ${entry.startsAt.toISOString()}::timestamptz, ${entry.endsAt.toISOString()}::timestamptz, ${capacity}, ${seriesId})
          returning id`);
        const id = row!.id;
        sessionIds.push(id);
        // The teacher, and the room when the class needs one, are held through the same overlap-proof reservations a visit uses.
        await transaction.execute(sql`
          insert into resource_reservations (tenant_id, class_session_id, practitioner_id, starts_at, ends_at, state)
          values (${context.tenantId}, ${id}, ${input.practitionerId}, ${entry.startsAt.toISOString()}::timestamptz, ${entry.endsAt.toISOString()}::timestamptz, 'confirmed')`);
        if (resourceId) {
          await transaction.execute(sql`
            insert into resource_reservations (tenant_id, class_session_id, resource_id, starts_at, ends_at, state)
            values (${context.tenantId}, ${id}, ${resourceId}, ${entry.startsAt.toISOString()}::timestamptz, ${entry.endsAt.toISOString()}::timestamptz, 'confirmed')`);
        }
      }
    } catch (error) {
      // Someone booked the teacher between the check and the save: nothing was created, say so plainly.
      if (getPostgresErrorCode(error) === "23P01") throw new ApiError(409, "slot_unavailable", "The teacher or room was just taken for one of these times. Nothing was created. Please check again.");
      throw error;
    }
    await audit(transaction, context, "class.sessions.created", { serviceId: input.serviceId, sessions: sessionIds.length, repeating: seriesId !== null });
    return { created: sessionIds.length, sessionIds, seriesId, clashes: [] };
  });
}

/** Changes how many seats a session has. More seats are offered straight away to the people waiting. */
export async function updateSessionCapacity(context: StaffContext, sessionId: string, input: { expectedVersion: number; capacity?: number }): Promise<SessionDetail> {
  manage(context);
  await withTenant(context.tenantId, async (transaction) => {
    const run = drizzleRunner(transaction);
    const session = await lockSession(run, context.tenantId, sessionId);
    if (!session || !canUseLocation(context, session.locationId)) throw new ApiError(404, "session_not_found", "That session was not found.");
    if (session.version !== input.expectedVersion) throw new ApiError(409, "version_conflict", "Someone else changed this session. Reload and try again.");
    if (session.status !== "scheduled") throw new ApiError(409, "session_closed", "A cancelled or finished session cannot change.");
    if (input.capacity !== undefined) {
      const held = await seatsHeld(run, context.tenantId, sessionId);
      if (input.capacity < held) throw new ApiError(409, "capacity_below_enrolled", `${held} seats are already taken. Move or cancel someone first.`);
      await transaction.execute(sql`update class_sessions set capacity = ${input.capacity}, version = version + 1, updated_at = now() where tenant_id = ${context.tenantId} and id = ${sessionId}`);
      await offerFreeSeats(run, context.tenantId, { ...session, capacity: input.capacity }, new Date());
      await audit(transaction, context, "class.session.capacity_changed", { sessionId, capacity: input.capacity });
    }
  });
  return getSession(context, sessionId);
}

/** Cancels a session: the teacher and room go free, and everyone with a seat or waiting is told. */
export async function cancelSession(context: StaffContext, sessionId: string, input: { expectedVersion: number; note?: string }): Promise<{ cancelled: number; notified: number }> {
  manage(context);
  return withTenant(context.tenantId, async (transaction) => {
    const run = drizzleRunner(transaction);
    const session = await lockSession(run, context.tenantId, sessionId);
    if (!session || !canUseLocation(context, session.locationId)) throw new ApiError(404, "session_not_found", "That session was not found.");
    if (session.version !== input.expectedVersion) throw new ApiError(409, "version_conflict", "Someone else changed this session. Reload and try again.");
    if (session.status !== "scheduled") throw new ApiError(409, "session_closed", "That session is already cancelled or finished.");
    await transaction.execute(sql`update class_sessions set status = 'cancelled', cancelled_at = now(), version = version + 1, updated_at = now() where tenant_id = ${context.tenantId} and id = ${sessionId}`);
    await transaction.execute(sql`update resource_reservations set state = 'released', updated_at = now() where tenant_id = ${context.tenantId} and class_session_id = ${sessionId} and state in ('held', 'confirmed')`);
    const people = await transaction.execute<{ id: string }>(sql`
      select id from class_enrolments where tenant_id = ${context.tenantId} and session_id = ${sessionId} and status in ('booked', 'waitlisted')`);
    await transaction.execute(sql`
      update class_enrolments set status = 'cancelled', cancelled_at = now(), cancelled_by = 'business', offer_expires_at = null, version = version + 1, updated_at = now()
      where tenant_id = ${context.tenantId} and session_id = ${sessionId} and status in ('booked', 'waitlisted')`);
    // The note is written for the customers, so it travels in the message only and never in the audit trail.
    for (const person of people) await queueNotice(run, context.tenantId, person.id, "session_cancelled", { nonce: `${sessionId}:${session.version}`, ...(input.note ? { message: input.note } : {}) });
    await audit(transaction, context, "class.session.cancelled", { sessionId, notified: people.length });
    return { cancelled: 1, notified: people.length };
  });
}

/** One-tap attendance. Marking again, or back to booked, is allowed so a mis-tap can be fixed. */
export async function markAttendance(context: StaffContext, sessionId: string, input: { enrolmentId: string; expectedVersion: number; outcome: "attended" | "no_show" | "booked" }): Promise<SessionDetail> {
  requirePermission(context, "appointments.status");
  requireDatabase(context);
  await withTenant(context.tenantId, async (transaction) => {
    // The session first, like every other seat change, so two taps never wait on each other in a circle.
    if (!(await lockSession(drizzleRunner(transaction), context.tenantId, sessionId))) throw new ApiError(404, "session_not_found", "That session was not found.");
    const [taught] = await transaction.execute<{ id: string }>(sql`select session.id from class_sessions as session where session.tenant_id = ${context.tenantId} and session.id = ${sessionId} ${await ownSessionClause(transaction, context)}`);
    if (!taught) throw new ApiError(404, "session_not_found", "That session was not found.");
    const [row] = await transaction.execute<{ status: EnrolmentStatus; version: number }>(sql`
      select status, version from class_enrolments where tenant_id = ${context.tenantId} and session_id = ${sessionId} and id = ${input.enrolmentId} for update`);
    if (!row) throw new ApiError(404, "enrolment_not_found", "That person is not on this roster.");
    if (Number(row.version) !== input.expectedVersion) throw new ApiError(409, "version_conflict", "Someone else changed this. Reload and try again.");
    if (!["booked", "attended", "no_show"].includes(row.status)) throw new ApiError(409, "not_seated", "Only someone with a seat can be marked present or absent.");
    await transaction.execute(sql`
      update class_enrolments set status = ${input.outcome}, version = version + 1, updated_at = now()
      where tenant_id = ${context.tenantId} and id = ${input.enrolmentId}`);
    await audit(transaction, context, `class.attendance.${input.outcome}`, { sessionId, enrolmentId: input.enrolmentId });
  });
  return getSession(context, sessionId);
}

/** Staff add someone at the door. Takes a seat when one is free; a full class stays full. */
export async function addWalkIn(context: StaffContext, sessionId: string, input: { patientId?: string | undefined; firstName?: string | undefined; lastName?: string | undefined; phone?: string | undefined; email?: string | undefined }): Promise<SessionDetail> {
  requirePermission(context, "appointments.book");
  requireDatabase(context);
  await withTenant(context.tenantId, async (transaction) => {
    const run = drizzleRunner(transaction);
    const session = await lockSession(run, context.tenantId, sessionId);
    if (!session || !canUseLocation(context, session.locationId)) throw new ApiError(404, "session_not_found", "That session was not found.");
    if (session.status !== "scheduled") throw new ApiError(409, "session_closed", "That session is cancelled or finished.");
    let patientId = input.patientId;
    if (patientId) {
      const [found] = await transaction.execute<{ id: string }>(sql`select id from patients where tenant_id = ${context.tenantId} and id = ${patientId}`);
      if (!found) throw new ApiError(404, "patient_not_found", "That customer was not found.");
    } else {
      patientId = await insertPatient(transaction, context.tenantId, { firstName: input.firstName ?? "", lastName: input.lastName ?? "", phone: input.phone ?? "", email: input.email ?? "", preferredChannel: "email", messagingConsent: false });
    }
    const held = await seatsHeld(run, context.tenantId, sessionId);
    if (held >= session.capacity) throw new ApiError(409, "class_full", "The class is full.", undefined, undefined, { waitlistOpen: true });
    const outcome = await takeSeat(transaction, context.tenantId, sessionId, patientId, "walk_in");
    if (outcome === "already") throw new ApiError(409, "already_enrolled", "That customer already has a seat.");
    await audit(transaction, context, "class.walk_in.added", { sessionId });
  });
  return getSession(context, sessionId);
}

/** Messages everyone on the roster (and optionally the waiting list) through the outbox. The text never goes in the audit trail. */
export async function messageEveryone(context: StaffContext, sessionId: string, input: { message: string; audience: "booked" | "booked_and_waiting" }, idempotencyKey: string): Promise<{ queued: number }> {
  requirePermission(context, "appointments.book");
  requireDatabase(context);
  return withTenant(context.tenantId, async (transaction) => {
    // Only a session this person can open (their locations; a practitioner's own classes) has a roster they may message.
    const [reachable] = await transaction.execute<{ id: string }>(sql`
      select session.id from class_sessions as session where session.tenant_id = ${context.tenantId} and session.id = ${sessionId} ${await ownSessionClause(transaction, context)}`);
    if (!reachable) throw new ApiError(404, "session_not_found", "That session was not found.");
    const claim = await claimKey<{ queued: number }>(transaction, context.tenantId, `/api/staff/classes/${sessionId}/message`, idempotencyKey, { sessionId, ...input });
    if ("replay" in claim) return claim.replay;
    const statuses = input.audience === "booked" ? ["booked", "attended", "no_show"] : ["booked", "attended", "no_show", "waitlisted"];
    const people = await transaction.execute<{ id: string }>(sql`
      select id from class_enrolments where tenant_id = ${context.tenantId} and session_id = ${sessionId}
        and status in (${sql.join(statuses.map((status) => sql`${status}`), sql`, `)})`);
    const run = drizzleRunner(transaction);
    for (const person of people) await queueNotice(run, context.tenantId, person.id, "broadcast", { nonce: idempotencyKey, message: input.message });
    await audit(transaction, context, "class.session.messaged", { sessionId, recipients: people.length });
    const result = { queued: people.length };
    await finishKey(transaction, claim.claimId, result);
    return result;
  });
}

/* ---------- Seats (shared by staff and customers) ---------- */

async function insertPatient(
  transaction: KalendrTransaction,
  tenantId: string,
  person: { firstName: string; lastName: string; phone: string; email: string; preferredChannel: "sms" | "email" | "whatsapp" | "phone"; messagingConsent: boolean },
): Promise<string> {
  const now = new Date().toISOString();
  const [matched] = await transaction.execute<{ id: string }>(sql`
    select id from patients
    where tenant_id = ${tenantId} and not is_dependent
      and lower(regexp_replace(trim(first_name || ' ' || last_name), '\\s+', ' ', 'g')) = ${joinFullName(person.firstName, person.lastName).toLowerCase()}
      and ((${person.email} <> '' and lower(email) = ${person.email.toLowerCase()})
        or (${person.phone} <> '' and kalendr_normalize_phone(phone) = kalendr_normalize_phone(${person.phone})))
    order by created_at limit 1`);
  if (matched) return matched.id;
  const [row] = await transaction.execute<{ id: string }>(sql`
    insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel, privacy_accepted_at, messaging_consent_at)
    values (${tenantId}, ${person.firstName.trim()}, ${person.lastName.trim()}, ${person.phone}, ${person.email.toLowerCase()}, ${person.preferredChannel},
      ${now}::timestamptz, ${person.messagingConsent ? now : null}::timestamptz)
    returning id`);
  return row!.id;
}

/**
 * Gives a person a seat (the session is already locked and a seat is free). A person who cancelled before gets their
 * old row back, since a customer can hold one place per session.
 */
async function takeSeat(transaction: KalendrTransaction, tenantId: string, sessionId: string, patientId: string, source: "online" | "staff" | "walk_in"): Promise<"booked" | "already" | "waiting"> {
  const [existing] = await transaction.execute<{ id: string; status: EnrolmentStatus }>(sql`
    select id, status from class_enrolments where tenant_id = ${tenantId} and session_id = ${sessionId} and patient_id = ${patientId} for update`);
  if (existing && (existing.status === "booked" || existing.status === "attended" || existing.status === "no_show")) return "already";
  if (existing?.status === "waitlisted") {
    // Someone waiting who now has a free seat takes it; any offer they held is theirs.
    await transaction.execute(sql`update class_enrolments set status = 'booked', offer_expires_at = null, version = version + 1, updated_at = now() where tenant_id = ${tenantId} and id = ${existing.id}`);
    return "booked";
  }
  if (existing) {
    await transaction.execute(sql`
      update class_enrolments set status = 'booked', cancelled_at = null, cancelled_by = null, offer_expires_at = null, offer_passed_at = null, source = ${source},
        version = version + 1, updated_at = now()
      where tenant_id = ${tenantId} and id = ${existing.id}`);
    return "booked";
  }
  const token = createOpaqueToken();
  const id = randomUUID();
  await transaction.execute(sql`
    insert into class_enrolments (id, tenant_id, session_id, patient_id, status, token_hash, token_sealed, source, created_at)
    values (${id}, ${tenantId}, ${sessionId}, ${patientId}, 'booked', ${sha256(token)}, ${sealPrivate(SEAT_SEAL_PURPOSE, tenantId, id, token)}, ${source}, clock_timestamp())`);
  return "booked";
}

/* ---------- Public timetable and enrolment ---------- */

async function tenantOf(slug: string): Promise<{ tenantId: string }> {
  const database = getDatabase();
  if (!database) throw new ApiError(503, "database_unavailable", "Booking is not available right now. Please try again shortly.");
  const [tenant] = await database.execute<{ tenant_id: string }>(sql`select tenant_id from kalendr_resolve_tenant(${slug}, null)`);
  if (!tenant) throw new ApiError(404, "clinic_not_found", "Business not found.");
  await assertTenantNotPaused(tenant.tenant_id);
  return { tenantId: tenant.tenant_id };
}

export async function listTimetable(query: { clinicSlug: string; locationId?: string | undefined; serviceId?: string | undefined; from?: string | undefined; to?: string | undefined }): Promise<TimetableSession[]> {
  const { tenantId } = await tenantOf(query.clinicSlug);
  const from = query.from ? new Date(query.from) : new Date();
  const to = query.to ? new Date(query.to) : new Date(from.getTime() + 28 * 86_400_000);
  return withTenant(tenantId, async (transaction) => {
    const [currency] = await transaction.execute<{ currency: string | null }>(sql`select currency from tenants where id = ${tenantId}`);
    const rows = await transaction.execute<SessionSqlRow & { price_minor: number | null; minimum_lead_minutes: number }>(sql`
      select * from (
        select session.id, session.version, session.service_id, service.name as service_name, session.practitioner_id, teacher.name as teacher_name,
          session.location_id, session.starts_at, session.ends_at, session.capacity, session.status, session.series_id, service.price_minor, service.minimum_lead_minutes,
          (select count(*) from class_enrolments as e where e.tenant_id = session.tenant_id and e.session_id = session.id
            and (e.status in ('booked', 'attended', 'no_show') or (e.status = 'waitlisted' and e.offer_expires_at is not null and e.offer_expires_at > now()))) as taken,
          0 as waiting
        from class_sessions as session
        join services as service on service.tenant_id = session.tenant_id and service.id = session.service_id and service.is_active and service.visibility = 'listed'
        join practitioners as teacher on teacher.tenant_id = session.tenant_id and teacher.id = session.practitioner_id
        where session.tenant_id = ${tenantId} and session.status = 'scheduled'
          and session.starts_at >= ${from.toISOString()}::timestamptz and session.starts_at < ${to.toISOString()}::timestamptz
          ${query.locationId ? sql`and session.location_id = ${query.locationId}` : sql``}
          ${query.serviceId ? sql`and session.service_id = ${query.serviceId}` : sql``}
      ) as listing order by starts_at, id limit 300`);
    const now = Date.now();
    return rows.map((row) => {
      const seatsLeft = Math.max(0, Number(row.capacity) - Number(row.taken));
      const starts = new Date(row.starts_at).getTime();
      const closed = starts - now < Number(row.minimum_lead_minutes) * MINUTE;
      return {
        id: row.id, serviceId: row.service_id, serviceName: row.service_name, locationId: row.location_id,
        startsAt: new Date(row.starts_at).toISOString(), endsAt: new Date(row.ends_at).toISOString(), teacherName: row.teacher_name,
        capacity: Number(row.capacity), seatsLeft, state: closed ? "closed" as const : seatsLeft === 0 ? "full" as const : "open" as const,
        priceMinor: row.price_minor === null ? null : Number(row.price_minor), currency: currency?.currency ?? "INR",
      };
    });
  });
}

/**
 * A customer takes a seat. In one transaction: lock the session row, count the seats, and take one only if one is free.
 * When the last seat is contested, the second person waits on the lock, sees the first person's seat, and is told the
 * class is full (with the waiting list on offer) rather than getting an error. The database trigger is the last guard.
 */
export async function enrol(sessionId: string, input: EnrolInput, idempotencyKey: string): Promise<EnrolResult> {
  const { tenantId } = await tenantOf(input.clinicSlug);
  return withTenant(tenantId, async (transaction) => {
    const claim = await claimKey<EnrolResult>(transaction, tenantId, `/api/public/classes/${sessionId}/enrol`, idempotencyKey, input);
    if ("replay" in claim) return claim.replay;
    const run = drizzleRunner(transaction);
    const session = await lockSession(run, tenantId, sessionId);
    if (!session || session.status !== "scheduled") throw new ApiError(404, "session_not_found", "That class was not found.");
    const [rules] = await transaction.execute<{ minimum_lead_minutes: number; visibility: string; is_active: boolean }>(sql`
      select minimum_lead_minutes, visibility, is_active from services where tenant_id = ${tenantId} and id = ${session.serviceId}`);
    if (!rules?.is_active) throw new ApiError(404, "session_not_found", "That class was not found.");
    if (session.startsAt.getTime() - Date.now() < Number(rules.minimum_lead_minutes) * MINUTE) {
      throw new ApiError(409, "class_closed", "Booking for this class has closed. Please call to ask about a place.");
    }
    const patientId = await insertPatient(transaction, tenantId, input);
    const held = await seatsHeld(run, tenantId, sessionId);
    let result: EnrolResult;
    let noticeEnrolment: string;
    let kind: "enrolled" | "waitlisted";
    if (held < session.capacity) {
      const outcome = await takeSeat(transaction, tenantId, sessionId, patientId, "online");
      if (outcome === "already") throw new ApiError(409, "already_enrolled", "You already have a place in this class.");
      const [seat] = await transaction.execute<{ id: string; token_sealed: string | null }>(sql`select id, token_sealed from class_enrolments where tenant_id = ${tenantId} and session_id = ${sessionId} and patient_id = ${patientId}`);
      noticeEnrolment = seat!.id;
      kind = "enrolled";
      result = { status: "booked", enrolmentId: seat!.id, manageToken: await tokenOf(transaction, tenantId, seat!.id) };
    } else {
      if (!input.joinWaitlist) {
        throw new ApiError(409, "class_full", "This class is full. You can join the waiting list.", undefined, undefined, { waitlistOpen: true });
      }
      const waiting = await joinWaiting(transaction, tenantId, sessionId, patientId);
      noticeEnrolment = waiting.id;
      kind = "waitlisted";
      result = { status: "waitlisted", enrolmentId: waiting.id, manageToken: waiting.token, position: await waitPosition(run, tenantId, sessionId, waiting.id) };
    }
    await queueNotice(run, tenantId, noticeEnrolment, kind, { nonce: idempotencyKey });
    await transaction.insert(auditEvents).values({ tenantId, actorType: "patient", action: kind === "enrolled" ? "class.enrolled" : "class.waitlist.joined", outcome: "success", metadata: { sessionId, source: "public" } });
    // A place booked online tells the staff who run the class (feature 56); joining the waiting list is not news yet.
    if (kind === "enrolled") await notifyStaff(transaction, tenantId, { kind: "new_booking", dedupeKey: `class.enrolled:${noticeEnrolment}`, startsAt: session.startsAt, practitionerId: session.practitionerId, locationId: session.locationId, link: "/classes" });
    await finishKey(transaction, claim.claimId, result);
    return result;
  });
}

/** The raw token is only ever held sealed; it is opened here once so the person who just booked can be shown their link. */
async function tokenOf(transaction: KalendrTransaction, tenantId: string, enrolmentId: string): Promise<string> {
  const { openPrivate } = await import("@/server/messaging/sealed-link");
  const [row] = await transaction.execute<{ token_sealed: string | null }>(sql`select token_sealed from class_enrolments where tenant_id = ${tenantId} and id = ${enrolmentId}`);
  return openPrivate(SEAT_SEAL_PURPOSE, tenantId, enrolmentId, row?.token_sealed ?? null) ?? "";
}

async function joinWaiting(transaction: KalendrTransaction, tenantId: string, sessionId: string, patientId: string): Promise<{ id: string; token: string }> {
  const [existing] = await transaction.execute<{ id: string; status: EnrolmentStatus }>(sql`
    select id, status from class_enrolments where tenant_id = ${tenantId} and session_id = ${sessionId} and patient_id = ${patientId} for update`);
  if (existing && existing.status !== "cancelled") {
    if (existing.status === "waitlisted") return { id: existing.id, token: await tokenOf(transaction, tenantId, existing.id) };
    throw new ApiError(409, "already_enrolled", "You already have a place in this class.");
  }
  if (existing) {
    await transaction.execute(sql`
      update class_enrolments set status = 'waitlisted', cancelled_at = null, cancelled_by = null, offer_expires_at = null, offer_passed_at = null,
        created_at = clock_timestamp(), version = version + 1, updated_at = now()
      where tenant_id = ${tenantId} and id = ${existing.id}`);
    return { id: existing.id, token: await tokenOf(transaction, tenantId, existing.id) };
  }
  const token = createOpaqueToken();
  const id = randomUUID();
  await transaction.execute(sql`
    insert into class_enrolments (id, tenant_id, session_id, patient_id, status, token_hash, token_sealed, source, created_at)
    values (${id}, ${tenantId}, ${sessionId}, ${patientId}, 'waitlisted', ${sha256(token)}, ${sealPrivate(SEAT_SEAL_PURPOSE, tenantId, id, token)}, 'online', clock_timestamp())`);
  return { id, token };
}

/* ---------- A customer's own link ---------- */

export interface MySeatView {
  enrolmentId: string;
  status: EnrolmentStatus;
  sessionStatus: SessionStatus;
  serviceName: string;
  teacherName: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  businessName: string;
  position: number | null;
  /** Set while the person holds an offered seat. */
  offerExpiresAt: string | null;
}

async function seatByToken(transaction: KalendrTransaction, tenantId: string, token: string): Promise<(MySeatView & { sessionId: string }) | null> {
  const [row] = await transaction.execute<{ id: string; session_id: string; status: EnrolmentStatus; offer_expires_at: Date | string | null; session_status: SessionStatus; service_name: string; teacher_name: string; starts_at: Date | string; ends_at: Date | string; timezone: string; business_name: string }>(sql`
    select e.id, e.session_id, e.status, e.offer_expires_at, session.status as session_status, service.name as service_name, teacher.name as teacher_name,
      session.starts_at, session.ends_at, location.timezone, tenant.name as business_name
    from class_enrolments as e
    join class_sessions as session on session.tenant_id = e.tenant_id and session.id = e.session_id
    join services as service on service.tenant_id = e.tenant_id and service.id = session.service_id
    join practitioners as teacher on teacher.tenant_id = e.tenant_id and teacher.id = session.practitioner_id
    join locations as location on location.tenant_id = e.tenant_id and location.id = session.location_id
    join tenants as tenant on tenant.id = e.tenant_id
    where e.tenant_id = ${tenantId} and e.token_hash = ${sha256(token)}`);
  if (!row) return null;
  const position = row.status === "waitlisted" ? await waitPosition(drizzleRunner(transaction), tenantId, row.session_id, row.id) : null;
  return {
    sessionId: row.session_id, enrolmentId: row.id, status: row.status, sessionStatus: row.session_status, serviceName: row.service_name, teacherName: row.teacher_name,
    startsAt: new Date(row.starts_at).toISOString(), endsAt: new Date(row.ends_at).toISOString(), timezone: row.timezone, businessName: row.business_name, position,
    offerExpiresAt: row.offer_expires_at && new Date(row.offer_expires_at).getTime() > Date.now() ? new Date(row.offer_expires_at).toISOString() : null,
  };
}

/** The token alone finds the business, through the same narrow lookup the manage links use. */
async function tenantForSeatToken(token: string): Promise<string> {
  const database = getDatabase();
  if (!database) throw new ApiError(503, "database_unavailable", "This page is not available right now. Please try again shortly.");
  const [row] = await database.execute<{ tenant_id: string }>(sql`select tenant_id from kalendr_resolve_class_seat(${sha256(token)})`);
  if (!row) throw new ApiError(404, "seat_not_found", "This link is not valid any more.");
  return row.tenant_id;
}

export async function getSeat(token: string): Promise<MySeatView> {
  const tenantId = await tenantForSeatToken(token);
  return withTenant(tenantId, async (transaction) => {
    const seat = await seatByToken(transaction, tenantId, token);
    if (!seat) throw new ApiError(404, "seat_not_found", "This link is not valid any more.");
    return { enrolmentId: seat.enrolmentId, status: seat.status, sessionStatus: seat.sessionStatus, serviceName: seat.serviceName, teacherName: seat.teacherName, startsAt: seat.startsAt, endsAt: seat.endsAt, timezone: seat.timezone, businessName: seat.businessName, position: seat.position, offerExpiresAt: seat.offerExpiresAt };
  });
}

/** Cancel a seat, take or turn down an offered seat. A freed seat goes to the first person waiting in the same transaction. */
export async function actOnSeat(token: string, action: "cancel" | "accept_offer" | "decline_offer"): Promise<MySeatView> {
  const tenantId = await tenantForSeatToken(token);
  await withTenant(tenantId, async (transaction) => {
    const run = drizzleRunner(transaction);
    const found = await seatByToken(transaction, tenantId, token);
    if (!found) throw new ApiError(404, "seat_not_found", "This link is not valid any more.");
    const session = await lockSession(run, tenantId, found.sessionId);
    if (!session) throw new ApiError(404, "seat_not_found", "This link is not valid any more.");
    const [current] = await transaction.execute<{ status: EnrolmentStatus; offer_expires_at: Date | string | null }>(sql`
      select status, offer_expires_at from class_enrolments where tenant_id = ${tenantId} and id = ${found.enrolmentId} for update`);
    if (!current) throw new ApiError(404, "seat_not_found", "This link is not valid any more.");
    const now = new Date();
    if (action === "accept_offer") {
      if (current.status !== "waitlisted" || !current.offer_expires_at || new Date(current.offer_expires_at).getTime() <= now.getTime()) {
        throw new ApiError(409, "offer_over", "This seat is no longer being held for you.");
      }
      if (session.status !== "scheduled") throw new ApiError(409, "session_closed", "This class has been cancelled.");
      await transaction.execute(sql`update class_enrolments set status = 'booked', offer_expires_at = null, version = version + 1, updated_at = now() where tenant_id = ${tenantId} and id = ${found.enrolmentId}`);
      await transaction.insert(auditEvents).values({ tenantId, actorType: "patient", action: "class.seat.accepted", outcome: "success", metadata: { sessionId: session.id } });
      await notifyStaff(transaction, tenantId, { kind: "waitlist_filled", dedupeKey: `class.offer.accepted:${found.enrolmentId}`, startsAt: session.startsAt, practitionerId: session.practitionerId, locationId: session.locationId, link: "/classes" });
      return;
    }
    if (action === "decline_offer") {
      if (current.status !== "waitlisted" || !current.offer_expires_at) return;
      const { passOffer } = await import("./class-seats");
      await passOffer(run, tenantId, found.enrolmentId, now, "declined");
      return;
    }
    if (current.status === "cancelled") return;
    if (!["booked", "waitlisted"].includes(current.status)) throw new ApiError(409, "not_cancellable", "This place can no longer be cancelled online. Please call.");
    await transaction.execute(sql`
      update class_enrolments set status = 'cancelled', cancelled_at = now(), cancelled_by = 'customer', offer_expires_at = null, version = version + 1, updated_at = now()
      where tenant_id = ${tenantId} and id = ${found.enrolmentId}`);
    await transaction.insert(auditEvents).values({ tenantId, actorType: "patient", action: "class.seat.cancelled", outcome: "success", metadata: { sessionId: session.id } });
    if (current.status === "booked") await notifyStaff(transaction, tenantId, { kind: "cancellation", dedupeKey: `class.seat.cancelled:${found.enrolmentId}`, startsAt: session.startsAt, practitionerId: session.practitionerId, locationId: session.locationId, link: "/classes" });
    await offerFreeSeats(run, tenantId, session, now);
  });
  return getSeat(token);
}

export type { SessionRow };
