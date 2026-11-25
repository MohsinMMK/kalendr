import type { BookingWindow } from "@/lib/service-setup";

import { addDays, localDateOf, MINUTE, DAY } from "./time";
import type { ServiceRules, Span } from "./types";

/**
 * What a service itself says about its slots: how far apart they start, how soon and how far
 * ahead they may be booked, and how much room they need around them. Everything here is a
 * plain function of numbers and dates so it can be tested without a database.
 */

export function slotInterval(service: Pick<ServiceRules, "slotIntervalMinutes" | "durationMinutes">): number {
  return service.slotIntervalMinutes ?? service.durationMinutes;
}

/**
 * The starts that fit inside one working range. The first grid point is `startOffsetMinutes` after
 * the range opens and each later one is an interval after that. The visit and both its buffers must
 * lie inside the range, so a cleaning buffer never runs past closing time.
 */
export function candidateStarts(range: Span, service: ServiceRules): number[] {
  const step = slotInterval(service) * MINUTE;
  const before = service.bufferBeforeMinutes * MINUTE;
  const after = (service.durationMinutes + service.bufferAfterMinutes) * MINUTE;
  const starts: number[] = [];
  for (let start = range.start + service.startOffsetMinutes * MINUTE; start + after <= range.end; start += step) {
    if (start - before >= range.start) starts.push(start);
  }
  return starts;
}

/** The span that must be free for a start: the visit and the buffers on both sides. */
export function reservedSpan(start: number, service: ServiceRules): Span {
  return {
    start: start - service.bufferBeforeMinutes * MINUTE,
    end: start + (service.durationMinutes + service.bufferAfterMinutes) * MINUTE,
  };
}

export function isWithinNotice(start: number, now: number, service: ServiceRules): boolean {
  return start < now + service.minimumNoticeMinutes * MINUTE;
}

/**
 * Whether `start` is later than the booking window allows. `openDays` are the days the business
 * works, in `timeZone`, ascending: "N business days ahead" skips the days it is closed.
 */
export function isBeyondWindow(start: number, now: number, window: BookingWindow, timeZone: string, openDays: readonly string[]): boolean {
  if (window.kind === "rolling_days") return start > now + window.days * DAY;
  const date = localDateOf(start, timeZone);
  if (window.kind === "date_range") return date < window.from || date > window.through;
  const today = localDateOf(now, timeZone);
  if (date < today) return true;
  const ahead = openDays.filter((day) => day > today);
  const lastAllowed = ahead[window.days - 1];
  return lastAllowed !== undefined && date > lastAllowed;
}

/** The last date a booking window reaches, when it can be told without the opening days. */
export function windowEndDate(window: BookingWindow, now: number, timeZone: string): string | null {
  if (window.kind === "rolling_days") return localDateOf(now + window.days * DAY, timeZone);
  if (window.kind === "date_range") return window.through;
  return null;
}

/** Days from `today` up to and including `through`, used to know how far to look for open days. */
export function daysUntil(today: string, through: string): number {
  let count = 0;
  for (let date = today; date < through; date = addDays(date, 1)) count += 1;
  return count;
}

/**
 * Extra starts for "optimized slots": the first moment a visit can begin right after a booking's time
 * (its buffers included, as `busy` already holds them) and the last moment one can end right before it.
 * Each must still sit inside the working range with its own buffers, so the later filters treat it like any grid start.
 */
export function adjacentStarts(range: Span, busy: readonly Span[], service: ServiceRules): number[] {
  const before = service.bufferBeforeMinutes * MINUTE;
  const length = service.durationMinutes * MINUTE;
  const after = service.bufferAfterMinutes * MINUTE;
  const starts = new Set<number>();
  for (const span of busy) {
    for (const start of [span.end + before, span.start - after - length]) {
      if (start - before >= range.start && start + length + after <= range.end) starts.add(start);
    }
  }
  return [...starts];
}
