import { TZDate } from "@date-fns/tz";

import { rangesOverlap, weekdays, type TimeRange, type WeeklyHours } from "@/lib/availability-setup";

/**
 * Pure translations between the shapes the screens use and the rows the database keeps.
 * Nothing here touches the database, so each can be tested alone.
 */

export interface RuleRow {
  dayOfWeek: number;
  startsAtLocal: string;
  endsAtLocal: string;
}

const trimSeconds = (time: string): string => (time.startsWith("24:00") ? "24:00" : time.slice(0, 5));
const withSeconds = (time: string): string => `${time}:00`;

/** One entry per range per day, in weekday then time order. */
export function weeklyToRows(weekly: WeeklyHours): RuleRow[] {
  return weekdays.flatMap((day) => [...weekly[day]]
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((range) => ({ dayOfWeek: Number(day), startsAtLocal: withSeconds(range.start), endsAtLocal: withSeconds(range.end) })));
}

/**
 * Rules are stored once per branch with the same times, so identical ranges collapse into one.
 * A person who works different hours at two branches shows the union.
 */
export function rowsToWeekly(rows: readonly RuleRow[]): WeeklyHours {
  const weekly: WeeklyHours = { "1": [], "2": [], "3": [], "4": [], "5": [], "6": [], "7": [] };
  const seen = new Set<string>();
  for (const row of [...rows].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startsAtLocal.localeCompare(b.startsAtLocal))) {
    const day = String(row.dayOfWeek) as keyof WeeklyHours;
    if (!weekly[day]) continue;
    const range: TimeRange = { start: trimSeconds(row.startsAtLocal), end: trimSeconds(row.endsAtLocal) };
    const key = `${day}|${range.start}|${range.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    weekly[day].push(range);
  }
  return weekly;
}

/** The days of a weekly pattern whose ranges overlap, for a plain error message. */
export function overlappingDays(weekly: WeeklyHours): string[] {
  return weekdays.filter((day) => rangesOverlap(weekly[day]));
}

function nextDate(date: string, add: number): { year: number; month: number; day: number } {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const moved = new Date(Date.UTC(year, month - 1, day + add));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

/** Local midnight at the start of `date` and local midnight after `throughDate`, in `timeZone`. */
export function wholeDaysToInstants(startsOn: string, throughDate: string, timeZone: string): { startsAt: Date; endsAt: Date } {
  const first = nextDate(startsOn, 0);
  const after = nextDate(throughDate, 1);
  return {
    startsAt: new Date(new TZDate(first.year, first.month - 1, first.day, 0, 0, 0, timeZone).getTime()),
    endsAt: new Date(new TZDate(after.year, after.month - 1, after.day, 0, 0, 0, timeZone).getTime()),
  };
}

function localDate(instant: Date, timeZone: string): string {
  const zoned = new TZDate(instant.getTime(), timeZone);
  return `${String(zoned.getFullYear()).padStart(4, "0")}-${String(zoned.getMonth() + 1).padStart(2, "0")}-${String(zoned.getDate()).padStart(2, "0")}`;
}

export function instantsToWholeDays(startsAt: Date, endsAt: Date, timeZone: string): { startsOn: string; throughDate: string } {
  return { startsOn: localDate(startsAt, timeZone), throughDate: localDate(new Date(endsAt.getTime() - 1), timeZone) };
}
