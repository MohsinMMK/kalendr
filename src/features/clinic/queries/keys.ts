import type { QueryKey } from "@tanstack/react-query";

/**
 * One stable key per list of staff data. Everything starts with `["staff"]`, so signing out can clear it all,
 * and live updates (feature 32) can invalidate by kind without knowing which screen is open.
 */
export const staffKeys = {
  all: ["staff"] as const,
  snapshot: () => ["staff", "snapshot"] as const,
  /** Every bookings list; one entry per tab and filter set, keyed by the query string the API reads. */
  bookings: () => ["staff", "bookings"] as const,
  bookingList: (queryString: string) => ["staff", "bookings", queryString] as const,
  patients: () => ["staff", "patients"] as const,
  notifications: () => ["staff", "notifications"] as const,
  notificationPreferences: () => ["staff", "notification-preferences"] as const,
  myNotifications: () => ["staff", "my-notifications"] as const,
  calendars: () => ["staff", "calendars"] as const,
  patientSearch: (query: string) => ["staff", "patients", "search", query] as const,
  staffSearch: (query: string) => ["staff", "search", query] as const,
};

/** What a live event says changed. The browser never trusts the event for data; it only refetches. */
export type LiveEventKind = "appointment" | "queue" | "message" | "notification";

/** The query keys a live event of this kind makes stale. */
export function keysForLiveEvent(kind: LiveEventKind): QueryKey[] {
  switch (kind) {
    case "appointment":
      return [staffKeys.snapshot(), staffKeys.patients()];
    case "queue":
    case "message":
      return [staffKeys.snapshot()];
    case "notification":
      return [staffKeys.notifications()];
  }
}
