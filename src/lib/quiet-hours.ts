import { z } from "zod";

/**
 * Quiet hours and the morning digest are stored as minutes after midnight in the business's time zone (feature 56).
 * These are the pure rules: whether a moment falls inside quiet hours, when they end, and how a time is written.
 */
export const minuteSchema = z.number().int().min(0).max(1439);

/** "HH:MM" to minutes after midnight, or null when it is not a time. */
export function parseClock(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function clockText(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** The minute of the day, and the calendar day, a moment falls on in a time zone. */
export function localParts(at: Date, timeZone: string): { minute: number; day: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(at);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return { minute: Number(value("hour")) * 60 + Number(value("minute")), day: `${value("year")}-${value("month")}-${value("day")}` };
}

/** Whether a minute of the day is inside a window that may wrap past midnight (22:00 to 07:00). */
export function insideWindow(minute: number, start: number, end: number): boolean {
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/**
 * When push and email may go out again, or null when they may go now. In-app alerts ignore this: they always appear.
 * The end is found by stepping a minute at a time, which keeps it right across daylight-saving changes.
 */
export function quietUntil(now: Date, timeZone: string, start: number | null, end: number | null): Date | null {
  if (start === null || end === null || start === end) return null;
  if (!insideWindow(localParts(now, timeZone).minute, start, end)) return null;
  const guess = new Date(now.getTime());
  for (let step = 0; step < 24 * 60 + 60; step += 1) {
    guess.setTime(guess.getTime() + 60_000);
    if (!insideWindow(localParts(guess, timeZone).minute, start, end)) return new Date(guess.getTime());
  }
  return null;
}
