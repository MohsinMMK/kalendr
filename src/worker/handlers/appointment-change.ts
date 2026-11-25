import { appointmentMessageHandler, type HandlerDependencies } from "./appointment-message";
import type { EventHandler } from "./types";

/**
 * Booked, confirmed, moved, suggested, cancelled and status changes. Each is dropped when the
 * appointment's version has moved on since the event was queued. Status changes with no
 * customer message (checked in, finished, no-show) are consumed without sending anything.
 */
export function appointmentChangeHandler(dependencies: HandlerDependencies): EventHandler {
  return appointmentMessageHandler(dependencies);
}
