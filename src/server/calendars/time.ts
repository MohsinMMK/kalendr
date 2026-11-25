/** Time-zone helpers shared by the adapters. All outputs are UTC ISO strings. */
import { TZDate } from "@date-fns/tz";

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** A wall-clock time in `zone` as a UTC ISO string. `month` is 1-12. */
export function zonedWallTimeToIso(
  parts: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number },
  zone: string,
): string {
  const date = new TZDate(parts.year, parts.month - 1, parts.day, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0, zone);
  return new Date(date.getTime()).toISOString();
}

export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday. */
  weekday: number;
}

export function wallTimeOf(instant: Date | string | number, zone: string): WallTime {
  const date = new TZDate(new Date(instant).getTime(), zone);
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
    weekday: date.getDay(),
  };
}

/** "2026-11-20" -> start of that day in `zone`. */
export function dateOnlyToIso(value: string, zone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError("Not a date-only value");
  return zonedWallTimeToIso({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }, zone);
}

/** Normalises any ISO timestamp with an offset to UTC; returns null when it does not parse. */
export function normaliseInstant(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
