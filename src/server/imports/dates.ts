import type { DateFormat } from "./contracts";

/**
 * Dates and times the way an owner's spreadsheet writes them. Parsing is strict: a day that does not exist (31/02) is
 * refused, never rolled into the next month, and a two-digit year is refused because it could mean two centuries.
 */

const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function isRealDate(year: number, month: number, day: number): boolean {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function iso(year: number, month: number, day: number): string | null {
  if (!isRealDate(year, month, day)) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const isoPattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const numericPattern = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/;
const namedPattern = /^(\d{1,2})[ -]([A-Za-z]{3,9})[ ,.-]*(\d{4})$/;

/** A date as "yyyy-mm-dd", or null when the text is not a real date in the chosen format. An ISO date always works. */
export function parseDate(text: string, format: DateFormat): string | null {
  const value = text.trim();
  if (!value) return null;
  const direct = isoPattern.exec(value);
  if (direct) return iso(Number(direct[1]), Number(direct[2]), Number(direct[3]));
  if (format === "yyyy-mm-dd") return null;
  if (format === "d-mmm-yyyy") {
    const named = namedPattern.exec(value);
    if (!named) return null;
    const month = months.indexOf(named[2]!.slice(0, 3).toLowerCase()) + 1;
    return month === 0 ? null : iso(Number(named[3]), month, Number(named[1]));
  }
  const numeric = numericPattern.exec(value);
  if (!numeric) return null;
  const first = Number(numeric[1]);
  const second = Number(numeric[3]);
  const year = Number(numeric[4]);
  return format === "dd/mm/yyyy" ? iso(year, second, first) : iso(year, first, second);
}

const timePattern = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*([AaPp])?\.?[Mm]?\.?$/;

/** A time as "HH:mm" (24 hour), from "14:30", "2:30 pm", "2pm" or "14:30:00". Null when it is not a time of day. */
export function parseTime(text: string): string | null {
  const match = timePattern.exec(text.trim());
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? "0");
  const seconds = Number(match[3] ?? "0");
  const meridiem = match[4]?.toLowerCase();
  if (minutes > 59 || seconds > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === "p" ? 12 : 0);
  } else if (hours > 23) {
    return null;
  } else if (match[2] === undefined) {
    // A bare "14" is a number, not a time.
    return null;
  }
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** A single cell holding both ("12/03/2027 14:30", "2027-03-12T14:30", "12-Mar-2027 2:30 pm"), or a date alone. */
export function parseDateAndTime(text: string, format: DateFormat): { date: string; time: string | null } | null {
  const value = text.trim().replace("T", " ");
  const split = /^(\d{4}-\d{2}-\d{2})(?:\s+(.+))?$/.exec(value) ?? /^(.*?\d{4})(?:[ ,]+(.+))?$/.exec(value);
  if (!split) return null;
  const date = parseDate(split[1]!, format);
  if (!date) return null;
  if (split[2] === undefined) return { date, time: null };
  const time = parseTime(split[2].replace(/(?:Z|[+-]\d{2}:?\d{2})$/, ""));
  return time ? { date, time } : null;
}

/** Today in "yyyy-mm-dd" in the given time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return parts;
}
