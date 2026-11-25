import { rangesOverlap, weekdays, type TimeRange, type Weekday, type WeeklyHours } from "@/lib/availability-setup";

/** Pure helpers for the weekly editor, kept apart from the screen so they can be tested alone. */

export const emptyWeek: WeeklyHours = { "1": [], "2": [], "3": [], "4": [], "5": [], "6": [], "7": [] };

const minutesOf = (time: string): number => {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  return hours * 60 + minutes;
};
const timeOf = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** The next range to offer after the last one: an hour, starting 30 minutes later, kept inside the day. */
export function nextRange(ranges: readonly TimeRange[]): TimeRange {
  const last = ranges[ranges.length - 1];
  if (!last) return { start: "09:00", end: "17:00" };
  const start = Math.min(minutesOf(last.end) + 30, 22 * 60);
  return { start: timeOf(start), end: timeOf(Math.min(start + 60, 24 * 60)) };
}

export function addRange(week: WeeklyHours, day: Weekday): WeeklyHours {
  return { ...week, [day]: [...week[day], nextRange(week[day])] };
}

export function removeRange(week: WeeklyHours, day: Weekday, index: number): WeeklyHours {
  return { ...week, [day]: week[day].filter((_, position) => position !== index) };
}

export function changeRange(week: WeeklyHours, day: Weekday, index: number, patch: Partial<TimeRange>): WeeklyHours {
  return { ...week, [day]: week[day].map((range, position) => position === index ? { ...range, ...patch } : range) };
}

/** Copies one day's ranges onto the other days. */
export function copyDay(week: WeeklyHours, from: Weekday, to: readonly Weekday[]): WeeklyHours {
  const next = { ...week };
  for (const day of to) if (day !== from) next[day] = week[from].map((range) => ({ ...range }));
  return next;
}

export const allWeekdays: readonly Weekday[] = weekdays;
export const workWeekdays: readonly Weekday[] = ["1", "2", "3", "4", "5"];

/** Whether a day is valid: every range ends after it starts and none overlap. */
export function dayIssue(ranges: readonly TimeRange[]): string | null {
  if (ranges.some((range) => range.end <= range.start)) return "A range must end after it starts.";
  if (rangesOverlap(ranges)) return "These times overlap. Change one so they sit one after the other.";
  return null;
}

export function weekIssue(week: WeeklyHours): string | null {
  for (const day of weekdays) {
    const issue = dayIssue(week[day]);
    if (issue) return issue;
  }
  return null;
}

/** "9:00–13:00, 15:00–19:00" for a quick read of a day. */
export function summariseDay(ranges: readonly TimeRange[]): string {
  return ranges.length === 0 ? "Closed" : ranges.map((range) => `${range.start}–${range.end}`).join(", ");
}

/** Whole-hour and half-hour differences read naturally: "10:30–18:30". Shifts a range by `offsetMinutes`. */
export function shiftRange(range: TimeRange, offsetMinutes: number): TimeRange {
  const wrap = (minutes: number) => ((minutes % 1440) + 1440) % 1440;
  return { start: timeOf(wrap(minutesOf(range.start) + offsetMinutes)), end: timeOf(wrap(minutesOf(range.end) + offsetMinutes)) };
}

/** The offset of a timezone from UTC at a moment, in minutes. */
export function zoneOffsetMinutes(timeZone: string, at: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((asUtc - Math.floor(at.getTime() / 60000) * 60000) / 60000);
}

/** What a range read in `travelZone` is on the clock of `homeZone`, so a traveller can check it. */
export function convertRange(range: TimeRange, travelZone: string, homeZone: string, at: Date = new Date()): TimeRange {
  return shiftRange(range, zoneOffsetMinutes(homeZone, at) - zoneOffsetMinutes(travelZone, at));
}
