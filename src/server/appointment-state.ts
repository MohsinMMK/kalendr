import type { AppointmentStatus } from "@/lib/domain";

const allowedTransitions: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  requested: ["booked", "cancelled", "declined", "expired", "entered_in_error"],
  // Staff may ask the customer to pick another time of a booking that has not started (feature 42).
  booked: ["checked_in", "cancelled", "no_show", "entered_in_error", "reschedule_requested"],
  // The customer chose a new time (booked), cancelled, or never answered (the system cancels it).
  reschedule_requested: ["booked", "cancelled", "entered_in_error"],
  checked_in: ["completed", "cancelled", "entered_in_error"],
  completed: ["entered_in_error"],
  cancelled: [],
  no_show: ["entered_in_error"],
  entered_in_error: [],
  declined: [],
  // Staff can only let go of a booking that is waiting for payment. Confirming it is the worker's job when the provider's
  // webhook arrives, and `expired` is set when the hold runs out: neither may be done by hand, or the slot could be double-booked.
  pending_payment: ["cancelled"],
  expired: [],
};

export function canTransitionAppointment(
  current: AppointmentStatus,
  next: AppointmentStatus,
): boolean {
  return current === next || allowedTransitions[current].includes(next);
}

export function isManageableAppointment(status: AppointmentStatus): boolean {
  return status === "requested" || status === "booked" || status === "reschedule_requested";
}
