import { and, eq, sql } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import { appointmentHostNoShows, appointments, resourceReservations } from "@/db/schema";
import type { BookingLocationChoice } from "@/lib/service-setup";
import { ApiError } from "@/server/api-error";
import { canTransitionAppointment } from "@/server/appointment-state";
import {
  loadBookingConfiguration,
  mutationResultFromRow,
  recordMutation,
  replaceReservations,
} from "@/server/appointment-repository";
import type { Actor } from "@/server/approval";
import type { AppointmentRow } from "@/server/appointment-tx";
import { resolveLocationChoice } from "@/server/booking-location";
import type { AppointmentMutationResult } from "@/server/preview-repository";
import { assertSlotOfferable } from "@/server/slot-engine/commit";
import { deliveryModeForKind } from "@/server/video/rules";
import { notifyPeople } from "@/server/people-alerts";
import { refundInFull } from "@/server/payments/business-fault-refund";
import { drizzleRunner } from "@/server/workflows/runner";

/**
 * Changes staff make to one booking from the bookings list (feature 43): move it to another person, change where it
 * happens, and record who did not turn up. Each runs inside the caller's locked, versioned transaction and is also
 * what the bulk actions call, one booking at a time.
 */

const LIVE: readonly string[] = ["requested", "booked"];

function timeInWords(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).format(date).toLowerCase();
}

export interface ReassignInput { practitionerId: string }

/** Moves a booking to another person at the same time, after checking they offer the service here and are free. */
export async function reassignIn(
  transaction: KalendrTransaction,
  current: AppointmentRow,
  actor: Actor,
  input: ReassignInput,
): Promise<AppointmentMutationResult> {
  if (!LIVE.includes(current.status)) throw new ApiError(409, "appointment_not_manageable", "Only a booking that has not started can be given to someone else.");
  if (input.practitionerId === current.practitionerId) throw new ApiError(409, "same_person", "That booking is already with them.");
  const [person] = await transaction.execute<{ name: string; timezone: string | null }>(sql`
    select practitioner.name, location.timezone
    from practitioners as practitioner
    join locations as location on location.tenant_id = practitioner.tenant_id and location.id = ${current.locationId}
    where practitioner.tenant_id = ${current.tenantId} and practitioner.id = ${input.practitionerId}
  `);
  if (!person) throw new ApiError(404, "practitioner_not_found", "That person is not in this business.");
  const configuration = await loadBookingConfiguration(transaction, current.tenantId, current.locationId, current.serviceId, input.practitionerId);
  if (!configuration) throw new ApiError(409, "not_offered", `${person.name} does not offer this service here.`);
  let resourceId: string | null = null;
  try {
    // The time stays; only the person changes. Hours, other bookings and blocks still apply; notice and window do not.
    const slot = await assertSlotOfferable(transaction, {
      tenantId: current.tenantId, locationId: current.locationId, serviceId: current.serviceId, practitionerId: input.practitionerId,
      startsAt: current.startsAt, endsAt: current.endsAt, mode: "existing", excludeAppointmentId: current.id, keepExistingLength: true,
    });
    resourceId = slot.resourceId;
  } catch (error) {
    if (error instanceof ApiError && (error.code === "slot_unavailable" || error.code === "limit_reached")) {
      throw new ApiError(409, "practitioner_busy", `${person.name} is busy at ${timeInWords(current.startsAt, person.timezone ?? "UTC")}.`);
    }
    throw error;
  }
  // A request that does not hold its slot keeps no reservation, wherever it goes.
  await replaceReservations(transaction, current.tenantId, current.id, input.practitionerId, current.startsAt, current.endsAt, configuration, resourceId);
  const [updated] = await transaction.update(appointments).set({
    practitionerId: input.practitionerId,
    version: current.version + 1,
    updatedAt: new Date(),
  }).where(and(eq(appointments.tenantId, current.tenantId), eq(appointments.id, current.id))).returning();
  if (!updated) throw new Error("Appointment update did not return a row");
  await recordMutation(
    transaction, current.tenantId, current.id, actor.type, "appointment.reassigned", updated.version, actor.userId,
    { fromPractitionerId: current.practitionerId, toPractitionerId: input.practitionerId },
  );
  // Both people hear about it, the one who gave it up and the one who took it.
  await notifyPeople(transaction, current.tenantId, {
    practitionerIds: [current.practitionerId, input.practitionerId],
    appointmentId: current.id,
    startsAt: current.startsAt,
    title: `A booking at ${timeInWords(current.startsAt, person.timezone ?? "UTC")} moved to ${person.name}`,
    dedupeKey: `appointment.reassigned:${current.id}:${updated.version}`,
    exceptUserId: actor.userId,
  });
  return mutationResultFromRow(updated);
}

/** Changes how and where a booking happens, and tells the customer. Only the service's own options are accepted. */
export async function editLocationIn(
  transaction: KalendrTransaction,
  current: AppointmentRow,
  actor: Actor,
  choice: BookingLocationChoice,
): Promise<AppointmentMutationResult> {
  if (!LIVE.includes(current.status)) throw new ApiError(409, "appointment_not_manageable", "Where it happens can only change on a booking that has not started.");
  const meeting = await resolveLocationChoice(transaction, current.tenantId, current.serviceId, current.locationId, choice);
  const [updated] = await transaction.update(appointments).set({
    locationKind: meeting.kind,
    locationDetail: meeting.detail,
    deliveryMode: deliveryModeForKind(meeting.kind),
    version: current.version + 1,
    updatedAt: new Date(),
  }).where(and(eq(appointments.tenantId, current.tenantId), eq(appointments.id, current.id))).returning();
  if (!updated) throw new Error("Appointment update did not return a row");
  // The kind is a fixed word; the address a customer gave is sealed and never in the audit trail.
  await recordMutation(transaction, current.tenantId, current.id, actor.type, "appointment.location_changed", updated.version, actor.userId, { locationKind: meeting.kind });
  return mutationResultFromRow(updated);
}

export type NoShowWho = "customer" | "host";

/** Records who did not turn up. The customer: status `no_show`. The business: the booking is cancelled in the customer's favour. */
export async function markNoShowIn(
  transaction: KalendrTransaction,
  current: AppointmentRow,
  actor: Actor,
  who: NoShowWho,
): Promise<AppointmentMutationResult> {
  if (current.startsAt.getTime() > Date.now() + 30 * 60_000) {
    throw new ApiError(409, "too_early", "A no-show can only be recorded once the visit time has come.");
  }
  const target = who === "customer" ? "no_show" : "cancelled";
  if (!["booked", "checked_in"].includes(current.status) || !canTransitionAppointment(current.status, target)) {
    throw new ApiError(409, "invalid_status_transition", "A no-show can only be recorded on a booking that was expected.");
  }
  await transaction.update(resourceReservations)
    .set({ state: "released", updatedAt: new Date() })
    .where(and(eq(resourceReservations.tenantId, current.tenantId), eq(resourceReservations.appointmentId, current.id)));
  const hostFields = who === "host"
    ? { cancelledAt: new Date(), cancelledBy: "staff" as const, cancelReasonCode: "staff_preset" as const, cancelPresetLabel: "The business did not turn up" }
    : { customerNoShowMarkedAt: new Date() };
  const [updated] = await transaction.update(appointments).set({
    status: target,
    ...hostFields,
    version: current.version + 1,
    updatedAt: new Date(),
  }).where(and(eq(appointments.tenantId, current.tenantId), eq(appointments.id, current.id))).returning();
  if (!updated) throw new Error("Appointment update did not return a row");
  if (who === "host") {
    await transaction.insert(appointmentHostNoShows).values({
      tenantId: current.tenantId, appointmentId: current.id, practitionerId: current.practitionerId, markedByUserId: actor.userId ?? null,
    }).onConflictDoNothing();
  }
  // The business's no-show goes to the customer as a cancellation, which carries the link to book again for free.
  await recordMutation(
    transaction, current.tenantId, current.id, actor.type,
    who === "host" ? "appointment.status.cancelled" : "appointment.status.no_show",
    updated.version, actor.userId,
    who === "host" ? { cancelledBy: "staff", reasonCode: "staff_preset", hostNoShow: true } : { noShowBy: "customer" },
  );
  // The cancellation above applied the customer's payment policy; the business missed this one, so the rest comes back too.
  if (who === "host") {
    await refundInFull(drizzleRunner(transaction), {
      tenantId: current.tenantId, appointmentId: current.id, source: "staff", reason: "The business did not turn up", actorUserId: actor.userId ?? null,
    });
  }
  return mutationResultFromRow(updated);
}
