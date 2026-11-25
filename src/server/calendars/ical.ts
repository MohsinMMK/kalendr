/**
 * Just enough iCalendar (RFC 5545) to read busy time from, and write appointments to,
 * a CalDAV calendar. The parser keeps only the properties availability needs
 * (UID, times, STATUS, TRANSP, RRULE, EXDATE, RECURRENCE-ID). SUMMARY, DESCRIPTION,
 * LOCATION and ATTENDEE lines are skipped without ever being read into a value.
 */
import { escapeIcsText } from "../../lib/event-wording";
import { isValidTimeZone, zonedWallTimeToIso } from "./time";

/** A date or date-time exactly as written, before any zone is applied. */
export interface IcsTime {
  allDay: boolean;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** True for a trailing Z. */
  utc: boolean;
  /** IANA name from TZID when we recognise it; null for floating or unknown names. */
  zone: string | null;
}

export interface ParsedEvent {
  uid: string;
  start: IcsTime;
  end: IcsTime | null;
  durationMs: number | null;
  status: string | null;
  transparent: boolean;
  rrule: string | null;
  exdates: IcsTime[];
  /** Set on an edited single occurrence of a repeating event. */
  recurrenceId: IcsTime | null;
}

const KEPT = new Set(["UID", "DTSTART", "DTEND", "DURATION", "STATUS", "TRANSP", "RRULE", "EXDATE", "RECURRENCE-ID"]);

export function unfold(text: string): string[] {
  return text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/).filter((line) => line.length > 0);
}

interface Line {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseLine(raw: string): Line | null {
  const colon = findUnquoted(raw, ":");
  if (colon < 0) return null;
  const head = raw.slice(0, colon);
  const value = raw.slice(colon + 1);
  const [name, ...rest] = head.split(";");
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const part of rest) {
    const eq = part.indexOf("=");
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value };
}

function findUnquoted(text: string, char: string): number {
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    if (current === '"') quoted = !quoted;
    else if (current === char && !quoted) return index;
  }
  return -1;
}

export function parseIcsTime(value: string, params: Record<string, string>): IcsTime | null {
  const trimmed = value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (date) {
    return { allDay: true, year: Number(date[1]), month: Number(date[2]), day: Number(date[3]), hour: 0, minute: 0, second: 0, utc: false, zone: null };
  }
  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(trimmed);
  if (!dateTime) return null;
  const tzid = params.TZID;
  return {
    allDay: false,
    year: Number(dateTime[1]),
    month: Number(dateTime[2]),
    day: Number(dateTime[3]),
    hour: Number(dateTime[4]),
    minute: Number(dateTime[5]),
    second: Number(dateTime[6]),
    utc: dateTime[7] === "Z",
    zone: tzid && isValidTimeZone(tzid) ? tzid : null,
  };
}

/** The instant an `IcsTime` means. Floating times, all-day dates and unknown zones use `fallbackZone`. */
export function icsTimeToIso(time: IcsTime, fallbackZone: string): string {
  const zone = time.utc ? "UTC" : (time.zone ?? fallbackZone);
  return zonedWallTimeToIso(time, zone);
}

export function parseDurationMs(value: string): number | null {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!match) return null;
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const total =
    (Number(weeks ?? 0) * 7 + Number(days ?? 0)) * 86_400_000 +
    Number(hours ?? 0) * 3_600_000 +
    Number(minutes ?? 0) * 60_000 +
    Number(seconds ?? 0) * 1000;
  return sign === "-" ? -total : total;
}

/** Every VEVENT in the text (VTIMEZONE, VALARM and the rest are ignored). */
export function parseEvents(text: string): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const stack: string[] = [];
  let current: Partial<ParsedEvent> & { exdates: IcsTime[] } = { exdates: [] };
  let uid: string | null = null;

  for (const raw of unfold(text)) {
    const upper = raw.toUpperCase();
    if (upper.startsWith("BEGIN:")) {
      stack.push(upper.slice(6).trim());
      if (stack[stack.length - 1] === "VEVENT" && stack.length === 2) {
        current = { exdates: [] };
        uid = null;
      }
      continue;
    }
    if (upper.startsWith("END:")) {
      const ended = stack.pop();
      if (ended === "VEVENT" && stack.length === 1 && uid && current.start) {
        events.push({
          uid,
          start: current.start,
          end: current.end ?? null,
          durationMs: current.durationMs ?? null,
          status: current.status ?? null,
          transparent: current.transparent ?? false,
          rrule: current.rrule ?? null,
          exdates: current.exdates,
          recurrenceId: current.recurrenceId ?? null,
        });
      }
      continue;
    }
    // Only read properties that sit directly inside a VEVENT, not inside its VALARM.
    if (stack[stack.length - 1] !== "VEVENT") continue;
    const propertyName = raw.slice(0, Math.max(raw.search(/[;:]/), 0)).toUpperCase();
    if (!KEPT.has(propertyName)) continue;
    const line = parseLine(raw);
    if (!line) continue;
    switch (line.name) {
      case "UID":
        uid = line.value.trim();
        break;
      case "DTSTART":
        current.start = parseIcsTime(line.value, line.params) ?? undefined;
        break;
      case "DTEND":
        current.end = parseIcsTime(line.value, line.params) ?? undefined;
        break;
      case "DURATION":
        current.durationMs = parseDurationMs(line.value) ?? undefined;
        break;
      case "STATUS":
        current.status = line.value.trim().toUpperCase();
        break;
      case "TRANSP":
        current.transparent = line.value.trim().toUpperCase() === "TRANSPARENT";
        break;
      case "RRULE":
        current.rrule = line.value.trim();
        break;
      case "EXDATE":
        for (const part of line.value.split(",")) {
          const parsed = parseIcsTime(part, line.params);
          if (parsed) current.exdates.push(parsed);
        }
        break;
      case "RECURRENCE-ID":
        current.recurrenceId = parseIcsTime(line.value, line.params) ?? undefined;
        break;
      default:
        break;
    }
  }
  return events;
}

// One shared escape for every iCalendar text value (feature 50); it also fixes semicolons, which this copy left bare.
const escapeText = escapeIcsText;

/** RFC 5545 asks for lines of at most 75 octets, continued with a leading space. */
function fold(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const width = encoder.encode(char).length;
    const limit = parts.length === 0 ? 75 : 74;
    if (size + width > limit) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += width;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

function utcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export interface IcsEventInput {
  uid: string;
  title: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
  /** Bumped on every update so other clients accept the change. */
  sequence: number;
  stamp: Date;
}

/** One VEVENT in UTC, marked opaque. Times in UTC avoid shipping a VTIMEZONE block. */
export function buildEventIcs(input: IcsEventInput): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Kalendr//Calendar Sync//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${input.uid}`,
    `DTSTAMP:${utcStamp(input.stamp)}`,
    `DTSTART:${utcStamp(input.start)}`,
    `DTEND:${utcStamp(input.end)}`,
    `SEQUENCE:${input.sequence}`,
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    `SUMMARY:${escapeText(input.title)}`,
    ...(input.description ? [`DESCRIPTION:${escapeText(input.description)}`] : []),
    ...(input.location ? [`LOCATION:${escapeText(input.location)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
