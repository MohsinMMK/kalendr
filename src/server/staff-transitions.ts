import { mutateStaffAppointment } from "@/server/appointment-repository";
import { approveRequestIn, declineRequestIn } from "@/server/approval";
import { editLocationIn, markNoShowIn, reassignIn } from "@/server/visit-actions";
import { cancelByStaffIn, editGuestsByStaffIn, rebookAppointment, requestRescheduleIn } from "@/server/cancel-actions";
import { reportBookingIn } from "@/server/spam";
import { withLockedStaffAppointment } from "@/server/appointment-tx";
import type { StaffAppointmentMutation } from "@/server/contracts";
import type { AppointmentMutationResult } from "@/server/preview-repository";
import type { StaffContext } from "@/server/staff-context";

/**
 * The one entry point the staff appointment route calls. State changes that live in their own files (approve,
 * decline, and the cancel and reschedule policy actions) are handled here; the rest go to the repository.
 */
export async function runStaffAppointmentAction(
  context: StaffContext,
  appointmentId: string,
  input: StaffAppointmentMutation,
): Promise<AppointmentMutationResult> {
  const actor = { type: "staff" as const, ...(context.userId ? { userId: context.userId } : {}) };
  switch (input.action) {
    case "approve":
      return withLockedStaffAppointment(context, appointmentId, input.expectedVersion, (transaction, current) =>
        approveRequestIn(transaction, current, actor, input.chosenStart ? { chosenStart: new Date(input.chosenStart) } : {}));
    case "decline":
      return withLockedStaffAppointment(context, appointmentId, input.expectedVersion, (transaction, current) =>
        declineRequestIn(transaction, current, actor, { reason: input.reason, ...(input.message ? { message: input.message } : {}) }));
    case "request_reschedule":
      return withLockedStaffAppointment(context, appointmentId, input.expectedVersion, (transaction, current) =>
        requestRescheduleIn(transaction, current, actor, input.message ? { message: input.message } : {}));
    case "cancel":
      return withLockedStaffAppointment(context, appointmentId, input.expectedVersion, (transaction, current) =>
        cancelByStaffIn(transaction, current, actor, {
          ...(input.presetId ? { presetId: input.presetId } : {}),
          ...(input.note ? { note: input.note } : {}),
          ...(input.notifyCustomer === false ? { notifyCustomer: false } : {}),
        }));
    case "report_spam":
      return withLockedStaffAppointment(context, appointmentId, input.expectedVersion, (transaction, current) =>
        reportBookingIn(transaction, current, actor, { reasonCode: input.reasonCode }));
    case "edit_guests":
      return withLockedStaffAppointment(context, appointmentId, input.expectedVersion, (transaction, current) =>
        editGuestsByStaffIn(transaction, current, actor, input.guests));
    case "reassign":
      return withLockedStaffAppointment(context, appointmentId, input.expectedVersion, (transaction, current) =>
        reassignIn(transaction, current, actor, { practitionerId: input.practitionerId }));
    case "edit_location":
      return withLockedStaffAppointment(context, appointmentId, input.expectedVersion, (transaction, current) =>
        editLocationIn(transaction, current, actor, input.locationChoice));
    case "mark_no_show":
      return withLockedStaffAppointment(context, appointmentId, input.expectedVersion, (transaction, current) =>
        markNoShowIn(transaction, current, actor, input.who));
    case "rebook":
      return rebookAppointment(context, appointmentId, input);
    default:
      return mutateStaffAppointment(context, appointmentId, input);
  }
}
