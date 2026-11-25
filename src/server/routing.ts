import { sql } from "drizzle-orm";

import { ANYONE, FAIR_SHARE_DAYS, explainAssignment, type RoutingCandidate } from "@/lib/routing-rank";
import type { AssignmentMode } from "@/lib/routing-contracts";
export { ANYONE };

import type { KalendrTransaction } from "@/db/client";
import { ApiError } from "@/server/api-error";
import { sha256 } from "@/server/crypto";
import { loadSlotInput } from "@/server/slot-engine/load";
import { offerableSlots } from "@/server/slot-engine/offerable-slots";
import { MINUTE } from "@/server/slot-engine/time";

/**
 * Team routing (feature 20). A customer who does not care who they see picks "Anyone available". The page shows the
 * union of everyone's free time; the person is chosen here, inside the booking transaction, because the person who
 * was free when the page was drawn may have been taken since.
 */

export interface RoutingRequest {
  tenantId: string;
  locationId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
  /** The customer's own hold, from the page. Its person is who the customer was shown. */
  holdToken?: string | undefined;
  /** To prefer the person this customer saw last time. */
  email?: string | undefined;
  /** Moving or approving an existing booking: its own time does not count as busy. */
  excludeAppointmentId?: string | undefined;
  /**
   * Routing forms (feature 46): only these people may be given the booking. Set by server code from a routing response,
   * never from a request body. Undefined means the whole pool.
   */
  candidateIds?: readonly string[] | undefined;
  /** Routing forms: how many times a person's weight counts, by person id (an attribute weighting). */
  weightMultipliers?: Readonly<Record<string, number>> | undefined;
}

interface PoolRow extends Record<string, unknown> {
  id: string;
  priority: number;
  weight: number;
  created_at: Date | string;
}

/**
 * Locks everyone who could take the booking, in id order so two bookings never wait on each other in a circle, and
 * returns them with their routing settings. Two "anyone" bookings for the same pool therefore queue one behind the other.
 */
export async function lockRoutingPool(
  transaction: KalendrTransaction,
  tenantId: string,
  locationId: string,
  serviceId: string,
): Promise<PoolRow[]> {
  return transaction.execute<PoolRow>(sql`
    select practitioner.id, practitioner_service.priority, practitioner_service.weight, practitioner.created_at
    from practitioner_services as practitioner_service
    join practitioners as practitioner
      on practitioner.tenant_id = practitioner_service.tenant_id and practitioner.id = practitioner_service.practitioner_id and practitioner.is_active
    join practitioner_locations as practitioner_location
      on practitioner_location.tenant_id = practitioner.tenant_id and practitioner_location.practitioner_id = practitioner.id
     and practitioner_location.location_id = ${locationId}
    join services as service on service.tenant_id = practitioner_service.tenant_id and service.id = practitioner_service.service_id and service.is_active
    join service_locations as service_location
      on service_location.tenant_id = service.tenant_id and service_location.service_id = service.id and service_location.location_id = ${locationId}
    where practitioner_service.tenant_id = ${tenantId} and practitioner_service.service_id = ${serviceId}
    order by practitioner.id
    for update of practitioner
  `);
}

/** Everyone in the pool who is free for the whole of this visit, found with the same rules the page used. */
async function freePeople(transaction: KalendrTransaction, request: RoutingRequest, holdIds: string[]): Promise<string[]> {
  const minutes = Math.round((request.endsAt.getTime() - request.startsAt.getTime()) / MINUTE);
  const loaded = await loadSlotInput(transaction, {
    tenantId: request.tenantId,
    locationId: request.locationId,
    serviceId: request.serviceId,
    durationMinutes: minutes,
    practitionerId: "first_available",
    from: request.startsAt,
    to: request.endsAt,
    mode: "standard",
    ...(request.excludeAppointmentId ? { excludeAppointmentId: request.excludeAppointmentId } : {}),
    ...(holdIds[0] ? { ignoreHoldId: holdIds[0] } : {}),
  });
  if (!loaded) return [];
  return offerableSlots(loaded.input)
    .filter((slot) => slot.startsAt.getTime() === request.startsAt.getTime())
    .map((slot) => slot.practitionerId);
}

async function loadCandidates(
  transaction: KalendrTransaction,
  request: RoutingRequest,
  pool: readonly PoolRow[],
  free: ReadonlySet<string>,
  now: Date,
): Promise<RoutingCandidate[]> {
  if (pool.length === 0) return [];
  const ids = pool.map((person) => person.id);
  const since = new Date(now.getTime() - FAIR_SHARE_DAYS * 86_400_000);
  const counts = await transaction.execute<{ practitioner_id: string; booked: number | string; last_at: Date | string | null }>(sql`
    select practitioner_id, count(*) as booked, max(created_at) as last_at
    from appointments
    where tenant_id = ${request.tenantId} and service_id = ${request.serviceId}
      and practitioner_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      and created_at >= ${since.toISOString()}::timestamptz
      and status in ('requested', 'booked', 'checked_in', 'completed', 'pending_payment')
    group by practitioner_id
  `);
  const byPerson = new Map(counts.map((row) => [row.practitioner_id, row]));
  // A person covering someone's leave at this time gets the new booking.
  const covering = await transaction.execute<{ cover_practitioner_id: string }>(sql`
    select distinct cover_practitioner_id from time_off
    where tenant_id = ${request.tenantId} and cover_practitioner_id is not null
      and starts_at < ${request.endsAt.toISOString()}::timestamptz and ends_at > ${request.startsAt.toISOString()}::timestamptz
  `);
  const coverIds = new Set(covering.map((row) => row.cover_practitioner_id));
  return pool.filter((person) => free.has(person.id)).map((person) => {
    const row = byPerson.get(person.id);
    return {
      id: person.id,
      priority: Number(person.priority),
      weight: Number(person.weight) * Math.max(1, request.weightMultipliers?.[person.id] ?? 1),
      recentCount: row ? Number(row.booked) : 0,
      lastBookedAt: row?.last_at ? new Date(row.last_at).getTime() : null,
      isNew: now.getTime() - new Date(person.created_at).getTime() < FAIR_SHARE_DAYS * 86_400_000,
      coversLeave: coverIds.has(person.id),
    };
  });
}

/** The person this customer saw last time for this service, found by email. Null for a first-time customer. */
async function lastPersonFor(transaction: KalendrTransaction, request: RoutingRequest): Promise<string | null> {
  if (!request.email) return null;
  const [row] = await transaction.execute<{ practitioner_id: string }>(sql`
    select appointment.practitioner_id
    from appointments as appointment
    join patients as patient on patient.tenant_id = appointment.tenant_id and patient.id = appointment.patient_id
    where appointment.tenant_id = ${request.tenantId} and appointment.service_id = ${request.serviceId}
      and lower(patient.email) = ${request.email.toLowerCase()}
      and appointment.status in ('booked', 'checked_in', 'completed')
    order by appointment.starts_at desc
    limit 1
  `);
  return row?.practitioner_id ?? null;
}

export interface Assignee {
  practitionerId: string;
  /** Why this person came first, in plain words ("had the fewest bookings in the last 30 days for their share"). */
  why: string;
  /** Everyone free at that time in the order they would be given the booking. The caller falls through it if one is taken. */
  order: string[];
}

/**
 * Picks the person for an "anyone" booking inside the booking transaction. Locks the pool, finds who is free now,
 * and ranks them. A customer who already holds a time keeps the person they were shown. Throws `slot_unavailable`
 * when nobody is free.
 */
export async function chooseAssignee(transaction: KalendrTransaction, request: RoutingRequest, now: Date = new Date()): Promise<Assignee> {
  const allowed = request.candidateIds ? new Set(request.candidateIds) : null;
  const pool = (await lockRoutingPool(transaction, request.tenantId, request.locationId, request.serviceId)).filter((person) => !allowed || allowed.has(person.id));
  if (pool.length === 0) throw unavailable();
  const [service] = await transaction.execute<{ assignment: AssignmentMode; prefer_returning_person: boolean }>(sql`
    select assignment, prefer_returning_person from services where tenant_id = ${request.tenantId} and id = ${request.serviceId}
  `);
  const assignment: AssignmentMode = service?.assignment === "round_robin" ? "round_robin" : "any_available";

  // The customer's own hold names the person the page showed them. The hold keeps that person free for them alone.
  if (request.holdToken) {
    const [held] = await transaction.execute<{ id: string; practitioner_id: string }>(sql`
      select id, practitioner_id from slot_holds
      where tenant_id = ${request.tenantId} and token_hash = ${sha256(request.holdToken)} and expires_at > now()
        and service_id = ${request.serviceId} and starts_at = ${request.startsAt.toISOString()}::timestamptz
    `);
    if (held && pool.some((person) => person.id === held.practitioner_id)) {
      return { practitionerId: held.practitioner_id, why: "was held for this customer when they chose the time", order: [held.practitioner_id] };
    }
  }

  const free = new Set(await freePeople(transaction, request, []));
  const candidates = await loadCandidates(transaction, request, pool, free, now);
  const preferredId = service?.prefer_returning_person ? await lastPersonFor(transaction, request) : null;
  const { order, why } = explainAssignment(candidates, { assignment, preferredId });
  const first = order[0];
  if (!first) throw unavailable();
  return { practitionerId: first, why, order };
}

function unavailable(): ApiError {
  return new ApiError(409, "slot_unavailable", "That time is no longer available. Please choose another slot.");
}
