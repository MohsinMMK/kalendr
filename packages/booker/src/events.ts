/**
 * The events the Booker reports to its host page. The names match the website embed's (feature 52), so one
 * analytics handler covers both. A payload carries ids and times only: never a name, email or phone number.
 */
export const bookerEventTypes = ["opened", "service_selected", "slot_selected", "booked", "rescheduled", "cancelled", "failed"] as const;
export type BookerEventType = (typeof bookerEventTypes)[number];

export interface BookerEvent {
  type: BookerEventType;
  serviceId?: string;
  personId?: string;
  startsAt?: string;
  endsAt?: string;
  appointmentId?: string;
  /** A short code such as `slot_unavailable`, never the server's message text. */
  errorCode?: string;
}

export type BookerEventHandler = (event: BookerEvent) => void;

/** Calls the host's handler and never lets a bug in it break booking. */
export function emitBookerEvent(handler: BookerEventHandler | undefined, event: BookerEvent): void {
  try {
    handler?.(event);
  } catch {
    // The host page's analytics are not ours to fix.
  }
}
