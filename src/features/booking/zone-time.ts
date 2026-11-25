import { zoneOffsetMinutes } from "@/lib/booking-page";

import { getDateKey } from "./booking-format";

/**
 * Date and time maths for the picker. Every day is a `YYYY-MM-DD` key in the zone being shown, so a week,
 * "today" and a day's openings all agree with what the visitor reads. The API stays in UTC.
 */

const DAY = 86_400_000;

function keyParts(key: string): [number, number, number] {
  const [year, month, day] = key.split("-").map(Number);
  return [year, month, day];
}

function keyFromUtcDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function addDaysToKey(key: string, days: number): string {
  const [year, month, day] = keyParts(key);
  return keyFromUtcDate(new Date(Date.UTC(year, month - 1, day + days)));
}

/** 0 is Sunday. */
export function weekdayOfKey(key: string): number {
  const [year, month, day] = keyParts(key);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function startOfWeekKey(key: string, weekStartsOn: 0 | 1): string {
  const back = (weekdayOfKey(key) - weekStartsOn + 7) % 7;
  return addDaysToKey(key, -back);
}

export function startOfMonthKey(key: string): string {
  return `${key.slice(0, 7)}-01`;
}

export function addMonthsToKey(key: string, months: number): string {
  const [year, month] = keyParts(key);
  return keyFromUtcDate(new Date(Date.UTC(year, month - 1 + months, 1)));
}

export function daysBetweenKeys(from: string, to: string): number {
  const [fy, fm, fd] = keyParts(from);
  const [ty, tm, td] = keyParts(to);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY);
}

/** The instant a calendar day begins in a zone. */
export function dayStartUtc(key: string, zone: string): Date {
  const [year, month, day] = keyParts(key);
  const wall = Date.UTC(year, month - 1, day);
  let guess = wall - zoneOffsetMinutes(zone, new Date(wall)) * 60_000;
  // A second pass settles days where the offset changes (daylight saving).
  guess = wall - zoneOffsetMinutes(zone, new Date(guess)) * 60_000;
  return new Date(guess);
}

export function todayKey(zone: string, now: Date = new Date()): string {
  return getDateKey(now.toISOString(), zone);
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

/** A clock time in a zone. `hour12` undefined follows the locale. */
export function formatClock(value: string, locale: string, zone: string, hour12?: boolean): string {
  const cycle = hour12 === undefined ? "" : hour12 ? "h12" : "h23";
  const cacheKey = `${locale}|${zone}|${cycle}`;
  let formatter = clockFormatters.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: zone,
      ...(hour12 === undefined ? {} : { hourCycle: hour12 ? "h12" : "h23" }),
    });
    if (clockFormatters.size >= 64) clockFormatters.delete(clockFormatters.keys().next().value!);
    clockFormatters.set(cacheKey, formatter);
  }
  return formatter.format(new Date(value));
}

/** "Tuesday 3 December" for a day key, written the way the locale writes it. */
export function formatDayKey(key: string, locale: string, options: Intl.DateTimeFormatOptions = { weekday: "long", day: "numeric", month: "long" }): string {
  const [year, month, day] = keyParts(key);
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** The name a screen reader hears for a time: "Tuesday 3 December, 10:30 am, Dr Rao". */
export function slotAccessibleName(input: { startsAt: string; locale: string; zone: string; hour12?: boolean; person?: string }): string {
  const day = formatDayKey(getDateKey(input.startsAt, input.zone), input.locale);
  return [day, formatClock(input.startsAt, input.locale, input.zone, input.hour12), input.person].filter(Boolean).join(", ");
}

export interface Interval {
  from: number;
  to: number;
}

/** Joins overlapping or touching intervals. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.from - b.from);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.from <= last.to) last.to = Math.max(last.to, interval.to);
    else merged.push({ ...interval });
  }
  return merged;
}

/** The part of a wanted range that has not been loaded yet, as one range, or null when it is all loaded. */
export function missingRange(wanted: Interval, covered: Interval[]): Interval | null {
  let cursor = wanted.from;
  let first: number | undefined;
  let last = wanted.from;
  for (const interval of mergeIntervals(covered)) {
    if (interval.to <= cursor) continue;
    if (interval.from >= wanted.to) break;
    if (interval.from > cursor) {
      first ??= cursor;
      last = Math.min(interval.from, wanted.to);
    }
    cursor = Math.max(cursor, interval.to);
    if (cursor >= wanted.to) break;
  }
  if (cursor < wanted.to) {
    first ??= cursor;
    last = wanted.to;
  }
  return first === undefined ? null : { from: first, to: last };
}

/** Cuts a range into windows of at most `days` days, so no response comes near the server's slot limit. */
export function splitRange(range: Interval, days = 14): Interval[] {
  const size = days * DAY;
  const windows: Interval[] = [];
  for (let from = range.from; from < range.to; from += size) windows.push({ from, to: Math.min(from + size, range.to) });
  return windows;
}

/**
 * Which days in the shown zone to cross out as fully booked. `fullDays` are dates in the business's zone. A shown
 * day counts only when it has no openings and every business date it touches is full; a day that straddles a full
 * business day and an open one is left unmarked.
 */
export function visitorFullDays(input: { fullDays: string[]; businessZone: string; displayZone: string; openDayKeys: Set<string> }): string[] {
  const { fullDays, businessZone, displayZone, openDayKeys } = input;
  if (fullDays.length === 0) return [];
  if (businessZone === displayZone) return fullDays.filter((key) => !openDayKeys.has(key));
  const full = new Set(fullDays);
  const candidates = new Set<string>();
  for (const key of fullDays) {
    const start = dayStartUtc(key, businessZone);
    const end = dayStartUtc(addDaysToKey(key, 1), businessZone);
    candidates.add(getDateKey(start.toISOString(), displayZone));
    candidates.add(getDateKey(new Date(end.getTime() - 1).toISOString(), displayZone));
  }
  return [...candidates].filter((shown) => {
    if (openDayKeys.has(shown)) return false;
    const start = dayStartUtc(shown, displayZone);
    const end = dayStartUtc(addDaysToKey(shown, 1), displayZone);
    const firstBusiness = getDateKey(start.toISOString(), businessZone);
    const lastBusiness = getDateKey(new Date(end.getTime() - 1).toISOString(), businessZone);
    for (let key = firstBusiness; key <= lastBusiness; key = addDaysToKey(key, 1)) {
      if (!full.has(key)) return false;
    }
    return true;
  }).sort();
}
