import { z } from "zod";

import { BOOKINGS_PAGE_DEFAULT, BOOKINGS_PAGE_MAX, bookingFilterSchema, type BookingTab, type SeriesStatus } from "@/lib/bookings-list";

/**
 * The Repeating tab of the Bookings list (feature 17 inside feature 43). Types and the query shape only, shared by the
 * screen, the route and the query, so the address bar, the request and the server read the same words.
 */

/** The same filters as the other tabs where they make sense for a series (customer, service, person, branch), plus its own status. */
export const seriesListQuerySchema = bookingFilterSchema.extend({
  sort: z.enum(["asc", "desc"]).default("asc"),
  cursor: z.string().trim().max(400).optional(),
  limit: z.number().int().min(1).max(BOOKINGS_PAGE_MAX).default(BOOKINGS_PAGE_DEFAULT),
});
export type SeriesListQuery = z.infer<typeof seriesListQuerySchema>;

export interface SeriesListRow {
  id: string;
  version: number;
  status: SeriesStatus;
  customer: { id: string; name: string };
  service: { id: string; name: string };
  practitioner: { id: string; name: string };
  location: { id: string; name: string };
  /** "Every Tuesday at 10:00 am for 8 weeks", in the business's own words. */
  summary: string;
  /** The place's time zone, for showing the next visit. */
  timezone: string;
  /** The next visit that is still ahead (booked, requested or checked in), or null when there is none. */
  nextVisit: { appointmentId: string; startsAt: string; index: number } | null;
  /** Visits that took place (completed or no-show) out of the visits still part of the series (cancelled ones are not counted). */
  visitsDone: number;
  visitsTotal: number;
}

export interface SeriesListPage {
  rows: SeriesListRow[];
  nextCursor: string | null;
  /** Counts for every tab under the same filters, with the first page; null afterwards. */
  counts: Record<BookingTab, number> | null;
  repeatingCount: number | null;
}
