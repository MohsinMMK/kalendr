/**
 * Expands a repeating event into the occurrences inside a window.
 *
 * `rrule` is not a dependency, so this covers the rules people actually create in
 * Apple Calendar: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL, COUNT, UNTIL,
 * BYDAY (with a week number for monthly, e.g. 1MO or -1FR), BYMONTHDAY (negative
 * allowed), BYMONTH and WKST. Anything else (BYSETPOS, BYHOUR, BYWEEKNO, BYYEARDAY,
 * HOURLY and finer) sets `unsupported`, and only the first occurrence is returned
 * so the event is still counted rather than silently dropped.
 *
 * Dates step in the event's own wall-clock zone, so a 09:00 weekly meeting stays at
 * 09:00 across a daylight-saving change.
 */
import { parseIcsTime, type IcsTime } from "./ical";
import { zonedWallTimeToIso } from "./time";

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const MAX_STEPS = 20_000;

export interface Occurrence {
  /** UTC ISO start. */
  startsAt: string;
}

interface Rule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count: number | null;
  until: IcsTime | null;
  byDay: { weekday: number; nth: number | null }[];
  byMonthDay: number[];
  byMonth: number[];
  weekStart: number;
}

function parseRule(rrule: string): Rule | null {
  const parts = new Map<string, string>();
  for (const piece of rrule.split(";")) {
    const eq = piece.indexOf("=");
    if (eq > 0) parts.set(piece.slice(0, eq).toUpperCase(), piece.slice(eq + 1));
  }
  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  for (const unsupported of ["BYSETPOS", "BYHOUR", "BYMINUTE", "BYSECOND", "BYYEARDAY", "BYWEEKNO"]) {
    if (parts.has(unsupported)) return null;
  }
  const byDay: Rule["byDay"] = [];
  for (const token of (parts.get("BYDAY") ?? "").split(",").filter(Boolean)) {
    const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(token);
    if (!match) return null;
    byDay.push({ weekday: WEEKDAYS.indexOf(match[2] ?? ""), nth: match[1] ? Number(match[1]) : null });
  }
  const numbers = (key: string): number[] => (parts.get(key) ?? "").split(",").filter(Boolean).map(Number);
  const untilText = parts.get("UNTIL");
  const interval = Math.max(1, Number(parts.get("INTERVAL") ?? 1) || 1);
  const count = parts.has("COUNT") ? Number(parts.get("COUNT")) : null;
  return {
    freq,
    interval,
    count: count !== null && Number.isFinite(count) ? count : null,
    until: untilText ? parseIcsTime(untilText, {}) : null,
    byDay,
    byMonthDay: numbers("BYMONTHDAY"),
    byMonth: numbers("BYMONTH"),
    weekStart: Math.max(0, WEEKDAYS.indexOf(parts.get("WKST") ?? "MO")),
  };
}

/** Pure calendar arithmetic on {y, m(1-12), d}, done in UTC so no zone can shift a date. */
interface Day {
  y: number;
  m: number;
  d: number;
}
const toUtc = (day: Day): number => Date.UTC(day.y, day.m - 1, day.d);
const fromUtc = (ms: number): Day => {
  const date = new Date(ms);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
};
const addDays = (day: Day, count: number): Day => fromUtc(toUtc(day) + count * 86_400_000);
const weekdayOf = (day: Day): number => new Date(toUtc(day)).getUTCDay();
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
const compareDays = (a: Day, b: Day): number => toUtc(a) - toUtc(b);

/** Days of one month matched by BYDAY entries (with or without a week number) and BYMONTHDAY. */
function monthDays(y: number, m: number, rule: Rule, fallbackDay: number): Day[] {
  const total = daysInMonth(y, m);
  const days = new Set<number>();
  if (rule.byMonthDay.length > 0) {
    for (const value of rule.byMonthDay) {
      const day = value > 0 ? value : total + value + 1;
      if (day >= 1 && day <= total) days.add(day);
    }
  }
  if (rule.byDay.length > 0) {
    for (const { weekday, nth } of rule.byDay) {
      const matching: number[] = [];
      for (let day = 1; day <= total; day += 1) if (weekdayOf({ y, m, d: day }) === weekday) matching.push(day);
      if (nth === null) matching.forEach((day) => days.add(day));
      else {
        const picked = nth > 0 ? matching[nth - 1] : matching[matching.length + nth];
        if (picked !== undefined) days.add(picked);
      }
    }
  }
  if (rule.byMonthDay.length === 0 && rule.byDay.length === 0 && fallbackDay <= total) days.add(fallbackDay);
  return [...days].sort((a, b) => a - b).map((d) => ({ y, m, d }));
}

function candidatesForPeriod(rule: Rule, start: Day, step: number): Day[] {
  switch (rule.freq) {
    case "DAILY":
      return [addDays(start, step * rule.interval)];
    case "WEEKLY": {
      const offset = (weekdayOf(start) - rule.weekStart + 7) % 7;
      const weekStart = addDays(start, -offset + step * rule.interval * 7);
      const weekdays = rule.byDay.length > 0 ? rule.byDay.map((entry) => entry.weekday) : [weekdayOf(start)];
      return weekdays
        .map((weekday) => addDays(weekStart, (weekday - rule.weekStart + 7) % 7))
        .sort((a, b) => compareDays(a, b));
    }
    case "MONTHLY": {
      const index = start.y * 12 + (start.m - 1) + step * rule.interval;
      return monthDays(Math.floor(index / 12), (index % 12) + 1, rule, start.d);
    }
    case "YEARLY": {
      const y = start.y + step * rule.interval;
      const months = rule.byMonth.length > 0 ? rule.byMonth : [start.m];
      return months.flatMap((m) => monthDays(y, m, rule, start.d));
    }
  }
}

export interface ExpandInput {
  start: IcsTime;
  /** The zone the event's wall-clock times live in (its TZID, or the fallback for floating times). */
  zone: string;
  durationMs: number;
  rrule: string;
  exdates: IcsTime[];
  windowStart: Date;
  windowEnd: Date;
}

export function expandOccurrences(input: ExpandInput): { occurrences: Occurrence[]; unsupported: boolean } {
  const first = zonedWallTimeToIso(input.start, input.zone);
  const firstOccurrence: Occurrence = { startsAt: first };
  const rule = parseRule(input.rrule);
  if (!rule) {
    return { occurrences: overlaps(first, input) ? [firstOccurrence] : [], unsupported: true };
  }
  const startDay: Day = { y: input.start.year, m: input.start.month, d: input.start.day };
  const excluded = new Set(input.exdates.map((time) => (time.allDay ? dayKey(time) : zonedWallTimeToIso(time, time.utc ? "UTC" : (time.zone ?? input.zone)))));
  const untilMs = rule.until ? untilInstant(rule.until, input.zone) : null;
  const windowEndMs = input.windowEnd.getTime();
  const occurrences: Occurrence[] = [];
  let produced = 0;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const days = candidatesForPeriod(rule, startDay, step);
    const periodFirst = days[0];
    if (periodFirst && Date.parse(zonedWallTimeToIso({ ...input.start, ...periodFirst, year: periodFirst.y, month: periodFirst.m, day: periodFirst.d }, input.zone)) > windowEndMs) break;
    for (const day of days) {
      if (compareDays(day, startDay) < 0) continue;
      const iso = zonedWallTimeToIso({ ...input.start, year: day.y, month: day.m, day: day.d }, input.zone);
      const ms = Date.parse(iso);
      if (untilMs !== null && ms > untilMs) return { occurrences, unsupported: false };
      produced += 1;
      if (rule.count !== null && produced > rule.count) return { occurrences, unsupported: false };
      if (excluded.has(iso) || excluded.has(dayKey({ ...input.start, year: day.y, month: day.m, day: day.d }))) continue;
      if (overlaps(iso, input)) occurrences.push({ startsAt: iso });
    }
  }
  return { occurrences, unsupported: false };
}

function dayKey(time: Pick<IcsTime, "year" | "month" | "day">): string {
  return `${time.year}-${time.month}-${time.day}`;
}

function overlaps(startIso: string, input: ExpandInput): boolean {
  const start = Date.parse(startIso);
  return start < input.windowEnd.getTime() && start + input.durationMs > input.windowStart.getTime();
}

/** A date-only UNTIL covers that whole day. */
function untilInstant(until: IcsTime, zone: string): number {
  if (until.allDay) return Date.parse(zonedWallTimeToIso({ ...until, hour: 23, minute: 59, second: 59 }, zone));
  return Date.parse(zonedWallTimeToIso(until, until.utc ? "UTC" : (until.zone ?? zone)));
}
