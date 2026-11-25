import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { randomUUID } from "node:crypto";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { appointments, resourceReservations } from "@/db/schema";
import { ApiError } from "@/server/api-error";
import { canTransitionAppointment } from "@/server/appointment-state";
import { createStaffAppointment, mutationResultFromRow, recordMutation, versionConflict } from "@/server/appointment-repository";
import type { Actor } from "@/server/approval";
import type { AppointmentRow } from "@/server/appointment-tx";
import { prepareGuestEdit, sealNote } from "@/server/booking-policy";
import type { AppointmentMutationResult } from "@/server/preview-repository";
import type { StaffContext } from "@/server/staff-context";
import { offerFreedSlot } from "@/server/waitlist-hook";

/**
 * The staff side of cancelling and moving (feature 42). Each runs inside the caller's locked, versioned transaction
 * (`withLockedStaffAppointment`), writes one audit row and queues its customer message through the outbox. Free text
 * (the customer-facing message, the staff note) is sealed or travels in the outbox only, never in audit metadata.
 */

function invalidMove(message: string): ApiError {
  return new ApiError(409, "invalid_status_transition", message);
}

async function releaseReservations(transaction: KalendrTransaction, tenantId: string, appointmentId: string): Promise<void> {
  await transaction.update(resourceReservations)
    .set({ state: "released", updatedAt: new Date() })
    .where(and(eq(resourceReservations.tenantId, tenantId), eq(resourceReservations.appointmentId, appointmentId)));
}

export interface RequestRescheduleInput {
  /** Words for the customer, carried to the worker in the outbox row. */
  message?: string;
}

/** Frees the slot and asks the customer to choose again. The booking keeps its id, history and manage link. */
export async function requestRescheduleIn(
  transaction: KalendrTransaction,
  current: AppointmentRow,
  actor: Actor,
  input: RequestRescheduleInput,
): Promise<AppointmentMutationResult> {
  if (!canTransitionAppointment(current.status, "reschedule_requested") || current.status === "reschedule_requested") {
    throw invalidMove("Only a booked appointment that has not started can be moved this way.");
  }
  await releaseReservations(transaction, current.tenantId, current.id);
  const [updated] = await transaction.update(appointments).set({
    status: "reschedule_requested",
    rescheduleRequestedAt: new Date(),
    confirmationStatus: "needs_action",
    version: current.version + 1,
    updatedAt: new Date(),
  }).where(and(eq(appointments.tenantId, current.tenantId), eq(appointments.id, current.id))).returning();
  if (!updated) throw new Error("Appointment update did not return a row");
  await recordMutation(
    transaction, current.tenantId, current.id, actor.type, "appointment.reschedule_requested", updated.version, actor.userId,
    { hasMessage: Boolean(input.message) },
    input.message ? { message: input.message } : undefined,
  );
  // Feature 21: the time this booking gave up goes to the first person waiting for it, inside this same transaction.
  await offerFreedSlot(transaction, current.tenantId, { locationId: current.locationId, serviceId: current.serviceId, practitionerId: current.practitionerId, startsAt: current.startsAt, endsAt: current.endsAt, excludePatientId: current.patientId });
  return mutationResultFromRow(updated);
}

export interface StaffCancelInput {
  presetId?: string;
  /** Staff-only note, sealed on the booking. */
  note?: string;
  notifyCustomer?: boolean;
}

/** Cancels on the business's side. A preset supplies the reason; the customer is told unless staff chose not to. */
export async function cancelByStaffIn(
  transaction: KalendrTransaction,
  current: AppointmentRow,
  actor: Actor,
  input: StaffCancelInput,
): Promise<AppointmentMutationResult> {
  if (current.status === "cancelled" || !canTransitionAppointment(current.status, "cancelled")) {
    throw invalidMove("This appointment can't be cancelled any more.");
  }
  let presetLabel: string | null = null;
  if (input.presetId) {
    const [preset] = await transaction.execute<{ label: string }>(sql`
      select label from cancel_note_presets where tenant_id = ${current.tenantId} and id = ${input.presetId}
    `);
    if (!preset) throw new ApiError(404, "preset_not_found", "That cancellation reason no longer exists.");
    presetLabel = preset.label;
  }
  await releaseReservations(transaction, current.tenantId, current.id);
  const [updated] = await transaction.update(appointments).set({
    status: "cancelled",
    confirmationStatus: current.status === "requested" ? "declined" : current.confirmationStatus,
    cancelledAt: new Date(),
    cancelledBy: actor.type === "system" ? "system" : "staff",
    cancelReasonCode: presetLabel ? "staff_preset" : "other",
    cancelPresetLabel: presetLabel,
    cancelReasonText: sealNote("cancel", current.tenantId, current.id, input.note),
    rescheduleRequestedAt: null,
    version: current.version + 1,
    updatedAt: new Date(),
  }).where(and(eq(appointments.tenantId, current.tenantId), eq(appointments.id, current.id))).returning();
  if (!updated) throw new Error("Appointment update did not return a row");
  await recordMutation(
    transaction, current.tenantId, current.id, actor.type, "appointment.status.cancelled", updated.version, actor.userId,
    { cancelledBy: "staff", reasonCode: presetLabel ? "staff_preset" : "other", ...(input.note ? { hasNote: true } : {}), ...(input.notifyCustomer === false ? { notifyCustomer: false } : {}) },
  );
  // Feature 21: the cancelled time goes to the first person waiting for it, inside this same transaction.
  await offerFreedSlot(transaction, current.tenantId, { locationId: current.locationId, serviceId: current.serviceId, practitionerId: current.practitionerId, startsAt: current.startsAt, endsAt: current.endsAt, excludePatientId: current.patientId });
  return mutationResultFromRow(updated);
}

/** Replaces the guest list. Staff may do it any time before the visit is over. */
export async function editGuestsByStaffIn(
  transaction: KalendrTransaction,
  current: AppointmentRow,
  actor: Actor,
  guests: string[],
): Promise<AppointmentMutationResult> {
  if (!["requested", "booked", "reschedule_requested"].includes(current.status)) {
    throw invalidMove("Guests can only change on a booking that has not started.");
  }
  const sealed = await prepareGuestEdit(transaction, current.tenantId, current.serviceId, current.id, guests);
  const [updated] = await transaction.update(appointments).set({
    guestEmailsCiphertext: sealed,
    version: current.version + 1,
    updatedAt: new Date(),
  }).where(and(eq(appointments.tenantId, current.tenantId), eq(appointments.id, current.id))).returning();
  if (!updated) throw new Error("Appointment update did not return a row");
  await recordMutation(
    transaction, current.tenantId, current.id, actor.type, "appointment.guests_updated", updated.version, actor.userId,
    { guestCount: guests.length },
  );
  return mutationResultFromRow(updated);
}

const REBOOKABLE: readonly string[] = ["cancelled", "declined", "expired", "no_show", "completed", "entered_in_error"];

/**
 * Books a cancelled or past visit again at a new time. It makes a new appointment for the same customer, service and
 * place, linked to the old one (`rebooked_from_id`), so the old booking's history stays as it was.
 */
export async function rebookAppointment(
  context: StaffContext,
  appointmentId: string,
  input: { startsAt: string; practitionerId?: string; expectedVersion: number },
): Promise<AppointmentMutationResult> {
  const original = await withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.select().from(appointments).where(and(eq(appointments.tenantId, context.tenantId), eq(appointments.id, appointmentId))).limit(1);
    return row;
  });
  if (!original) throw new ApiError(404, "appointment_not_found", "Appointment not found.");
  if (original.version !== input.expectedVersion) throw versionConflict();
  const finished = REBOOKABLE.includes(original.status) || (original.status === "booked" && original.endsAt.getTime() < Date.now());
  if (!finished) throw invalidMove("Only a cancelled or past appointment can be booked again.");
  const [tenant] = await withTenant(context.tenantId, (transaction) => transaction.execute<{ slug: string }>(sql`select slug from tenants where id = ${context.tenantId}`));
  if (!tenant) throw new ApiError(404, "clinic_not_found", "Business not found.");
  const lengthMinutes = Math.round((original.endsAt.getTime() - original.startsAt.getTime()) / 60_000);
  const key = randomUUID();
  const created = await createStaffAppointment(context, {
    clinicSlug: tenant.slug,
    locationId: original.locationId,
    serviceId: original.serviceId,
    practitionerId: input.practitionerId ?? original.practitionerId,
    startsAt: input.startsAt,
    durationMinutes: lengthMinutes,
    source: "desk",
    patientId: original.patientId,
    rebookedFromId: original.id,
  }, key, key.replaceAll("-", ""));
  return { appointmentId: created.appointmentId, status: created.status, startsAt: created.startsAt, endsAt: created.endsAt, version: created.version };
}
