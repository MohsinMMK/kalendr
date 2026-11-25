import { and, eq, ne, sql } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import { appointments, resourceReservations } from "@/db/schema";
import { type DeclineReason } from "@/lib/approval";
import { ApiError } from "@/server/api-error";
import { canTransitionAppointment } from "@/server/appointment-state";
import {
  loadBookingConfiguration,
  mutationResultFromRow,
  recordMutation,
  replaceReservations,
} from "@/server/appointment-repository";
import type { AppointmentMutationResult } from "@/server/preview-repository";
import { offerFreedSlot } from "@/server/waitlist-hook";
import { assertSlotOfferable } from "@/server/slot-engine/commit";
import type { AppointmentRow } from "@/server/appointment-tx";

/**
 * Approving and declining requests (feature 41). Both run inside the caller's locked, versioned transaction, so a
 * request is decided once. Approval is the only way a request becomes a booking: the plain status endpoint and the
 * bulk "confirm" action call `approveRequestIn` too, so a request that did not hold its slot can never be
 * confirmed into a double booking.
 */

export interface Actor {
  type: "staff" | "system";
  userId?: string;
}

function notRequested(): ApiError {
  return new ApiError(409, "invalid_status_transition", "Only a request that is waiting for approval can be approved or declined.");
}

/** Does the appointment still have a reservation holding its time? A request that did not hold its slot has none. */
async function holdsTime(transaction: KalendrTransaction, tenantId: string, appointmentId: string): Promise<boolean> {
  const [row] = await transaction.execute<{ held: boolean }>(sql`
    select exists (
      select 1 from resource_reservations
      where tenant_id = ${tenantId} and appointment_id = ${appointmentId}
        and (state = 'confirmed' or (state = 'held' and hold_expires_at > now()))
    ) as held
  `);
  return row?.held === true;
}

export interface ApproveOptions {
  /** One of the times the customer offered. The appointment moves to it. */
  chosenStart?: Date;
}

/** Turns a request into a booking, at its own time or at one of the times the customer offered. */
export async function approveRequestIn(
  transaction: KalendrTransaction,
  current: AppointmentRow,
  actor: Actor,
  options: ApproveOptions = {},
): Promise<AppointmentMutationResult> {
  const tenantId = current.tenantId;
  if (current.status !== "requested" || !canTransitionAppointment("requested", "booked")) throw notRequested();

  let startsAt = current.startsAt;
  let endsAt = current.endsAt;
  const lengthMs = current.endsAt.getTime() - current.startsAt.getTime();
  const moved = options.chosenStart !== undefined && options.chosenStart.getTime() !== current.startsAt.getTime();
  if (options.chosenStart) {
    const offered = (current.proposedStarts ?? []).some((time) => time.getTime() === options.chosenStart!.getTime());
    if (!moved) { /* choosing the original time is the same as approving it */ }
    else if (!offered) throw new ApiError(400, "validation_error", "That time is not one the customer offered.");
    startsAt = options.chosenStart;
    endsAt = new Date(startsAt.getTime() + lengthMs);
  }

  const holding = await holdsTime(transaction, tenantId, current.id);
  // A request that held its slot at its own time needs no new check. Everything else must find the time still free.
  if (moved || !holding) {
    const configuration = await loadBookingConfiguration(transaction, tenantId, current.locationId, current.serviceId, current.practitionerId);
    if (!configuration) throw new ApiError(409, "request_slot_taken", "This person no longer offers that service here. Choose another time or decline the request.");
    let resourceId: string | null;
    try {
      // The customer asked for this time while it was open; notice and window no longer apply, but hours, other bookings and blocks do.
      const slot = await assertSlotOfferable(transaction, {
        tenantId, locationId: current.locationId, serviceId: current.serviceId, practitionerId: current.practitionerId,
        startsAt, endsAt, mode: "existing", enforceLimits: true, excludeAppointmentId: current.id, keepExistingLength: true,
      });
      resourceId = slot.resourceId;
    } catch (error) {
      if (error instanceof ApiError && error.code === "limit_reached") {
        // The time is free; a booking limit is full. Say so, so staff don't hunt for a clash that isn't there.
        throw new ApiError(409, "request_limit_reached", `${error.message} Choose another time for this request, or decline it.`);
      }
      if (error instanceof ApiError && error.code === "slot_unavailable") {
        throw new ApiError(409, "request_slot_taken", "That time is no longer free. Choose another time for this request, or decline it.");
      }
      throw error;
    }
    await replaceReservations(transaction, tenantId, current.id, current.practitionerId, startsAt, endsAt, configuration, resourceId, { force: true });
  }

  const [updated] = await transaction.update(appointments).set({
    status: "booked",
    confirmationStatus: "confirmed",
    startsAt,
    endsAt,
    proposedStarts: null,
    reminderStatus: "queued",
    version: current.version + 1,
    updatedAt: new Date(),
  }).where(and(eq(appointments.tenantId, tenantId), eq(appointments.id, current.id))).returning();
  if (!updated) throw new Error("Appointment update did not return a row");
  await recordMutation(
    transaction, tenantId, current.id, actor.type, "appointment.status.booked", updated.version, actor.userId,
    { via: "approval", ...(moved ? { movedToProposed: true } : {}) },
  );
  return mutationResultFromRow(updated);
}

export interface DeclineInput {
  reason: DeclineReason;
  /** Shown to the customer only. It travels in the outbox row, never in the audit trail or a log. */
  message?: string;
}

/** Turns a request down and frees whatever it held. */
export async function declineRequestIn(
  transaction: KalendrTransaction,
  current: AppointmentRow,
  actor: Actor,
  input: DeclineInput,
): Promise<AppointmentMutationResult> {
  const tenantId = current.tenantId;
  if (current.status !== "requested" || !canTransitionAppointment("requested", "declined")) throw notRequested();
  const released = await transaction.update(resourceReservations)
    .set({ state: "released", updatedAt: new Date() })
    .where(and(eq(resourceReservations.tenantId, tenantId), eq(resourceReservations.appointmentId, current.id), ne(resourceReservations.state, "released")))
    .returning({ id: resourceReservations.id });
  const [updated] = await transaction.update(appointments).set({
    status: "declined",
    confirmationStatus: "declined",
    declineReasonCode: input.reason,
    proposedStarts: null,
    version: current.version + 1,
    updatedAt: new Date(),
  }).where(and(eq(appointments.tenantId, tenantId), eq(appointments.id, current.id))).returning();
  if (!updated) throw new Error("Appointment update did not return a row");
  await recordMutation(
    transaction, tenantId, current.id, actor.type, "appointment.status.declined", updated.version, actor.userId,
    { reason: input.reason, hasMessage: Boolean(input.message) },
    { reason: input.reason, ...(input.message ? { message: input.message } : {}) },
  );
  // Feature 21: a request that was holding its time gives it to the first person waiting, inside this same transaction.
  if (released.length > 0) await offerFreedSlot(transaction, tenantId, { locationId: current.locationId, serviceId: current.serviceId, practitionerId: current.practitionerId, startsAt: current.startsAt, endsAt: current.endsAt, excludePatientId: current.patientId });
  return mutationResultFromRow(updated);
}
