/**
 * What the repeating-appointment routes return (feature 17). Types only, so the screens and the server share one shape
 * and neither pulls in the other's code.
 */
import type { RepeatRule } from "./series-rule";

/** The outbox event that carries the one message for a whole series. */
export const SERIES_CONFIRMATION_EVENT = "series.confirmation";

/** One visit of a series as the preview shows it, before anything is saved. */
export interface SeriesPreviewVisit {
  /** Its place in the rule, counting from 1. */
  index: number;
  /** The calendar date at the place, `YYYY-MM-DD`. */
  date: string;
  startsAt: string;
  endsAt: string;
  state: "free" | "clash";
  /** The engine's reason code when it clashes, such as `already_booked`. */
  reason?: string;
  /** A plain sentence for that reason: "Already booked", "Holiday: Diwali". */
  reasonLabel?: string;
  /** Other free times that same day for the same person, when the visit clashes. */
  alternatives: Array<{ startsAt: string; endsAt: string }>;
}

export interface SeriesPreview {
  timezone: string;
  /** The first day and clock time the rule runs from, read at the place. */
  startsOn: string;
  timeOfDay: string;
  ruleText: string;
  visits: SeriesPreviewVisit[];
  /** True when the rule asked for more than 52 visits or 12 months and the list stops early. */
  capped: boolean;
  freeCount: number;
  clashCount: number;
}

/** Staff's answer for one clashing visit. A visit with no answer is booked at its own time. */
export interface SeriesResolution {
  index: number;
  action: "skip" | "move";
  /** For `move`: another start on the same day, from the alternatives offered. */
  startsAt?: string;
}

export type SeriesSaveResult =
  | { saved: true; seriesId: string; visitCount: number; skippedCount: number; appointmentIds: string[] }
  /** Something changed between the preview and the save, so nothing was saved: the list again, as it is now. */
  | { saved: false; preview: SeriesPreview };

export interface SeriesVisitRow {
  appointmentId: string;
  index: number;
  startsAt: string;
  endsAt: string;
  status: string;
}

export interface SeriesView {
  id: string;
  status: "active" | "ended" | "cancelled";
  version: number;
  patientId: string;
  serviceId: string;
  practitionerId: string;
  locationId: string;
  timezone: string;
  rule: RepeatRule;
  ruleText: string;
  startsOn: string;
  timeOfDay: string;
  durationMinutes: number;
  /** "Every Tuesday at 10:00 am for 8 weeks". */
  summary: string;
  continuedFromId: string | null;
  continuedById: string | null;
  visits: SeriesVisitRow[];
}

export type SeriesChangeResult =
  | { changed: true; seriesId: string; newSeriesId: string | null; cancelledCount: number; bookedCount: number; keptCount: number }
  | { changed: false; preview: SeriesPreview };
