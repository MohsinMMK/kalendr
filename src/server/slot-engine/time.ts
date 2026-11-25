import { TZDate } from "@date-fns/tz";

import type { Span } from "./types";

export const MINUTE = 60_000;
export const DAY = 86_400_000;

/** `YYYY-MM-DD` of an instant, as read on a wall clock in `timeZone`. */
export function localDateOf(epoch: number, timeZone: string): string {
  const zoned = new TZDate(epoch, timeZone);
  return formatDate(zoned.getFullYear(), zoned.getMonth() + 1, zoned.getDate());
}

export function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseDate(date: string): { year: number; month: number; day: number } {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return { year, month, day };
}

export function addDays(date: string, days: number): string {
  const { year, month, day } = parseDate(date);
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return formatDate(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
}

/** 1 for Monday to 7 for Sunday. */
export function isoWeekday(date: string): number {
  const { year, month, day } = parseDate(date);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/** The instant a wall clock reads `date` and `time` in `timeZone`. A time inside a clock change moves forward. */
export function localInstant(date: string, time: string, timeZone: string): number {
  const { year, month, day } = parseDate(date);
  const [hours = 0, minutes = 0, seconds = 0] = time.split(":").map(Number);
  return new TZDate(year, month - 1, day, hours, minutes, seconds, timeZone).getTime();
}

/** Every date from `first` to `last`, both included. */
export function datesBetween(first: string, last: string): string[] {
  const dates: string[] = [];
  for (let date = first; date <= last; date = addDays(date, 1)) dates.push(date);
  return dates;
}

export function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Sorts spans and joins any that touch or overlap. */
export function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}
