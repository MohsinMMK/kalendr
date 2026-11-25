import type { AppointmentStatus } from "@/lib/domain";
import { escapeIcsText } from "@/lib/event-wording";
import type { TermWords } from "@/lib/terminology";

export interface CalendarAppointmentInput {
  appointmentId: string;
  version: number;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  clinicName: string;
  clinicPhone: string;
  serviceName: string;
  practitionerName: string;
  locationName: string;
  locationAddress: string;
  locationCity: string;
  /** The business's own words. Leaving it out keeps the healthcare wording. */
  words?: Pick<TermWords, "Appointment">;
  /** The business's own wording for this service (feature 50). Without it the usual title and description are written. */
  entry?: { title: string; description: string | null };
}

export function createAppointmentCalendar(
  input: CalendarAppointmentInput,
  generatedAt = new Date(),
): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Kalendr//Clinic Appointments//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${escapeCalendarText(`${input.appointmentId}@kalendr.app`)}`,
    `DTSTAMP:${formatCalendarDate(generatedAt)}`,
    `DTSTART:${formatCalendarDate(new Date(input.startsAt))}`,
    `DTEND:${formatCalendarDate(new Date(input.endsAt))}`,
    `SEQUENCE:${Math.max(0, input.version)}`,
    `STATUS:${calendarStatus(input.status)}`,
    `SUMMARY:${escapeCalendarText(input.entry?.title ?? `${input.serviceName} · ${input.clinicName}`)}`,
    // Left out while a request waits on a service that hides its address.
    ...(input.locationName || input.locationAddress || input.locationCity
      ? [`LOCATION:${escapeCalendarText([input.locationName, input.locationAddress, input.locationCity].filter(Boolean).join(", "))}`]
      : []),
    `DESCRIPTION:${escapeCalendarText(input.entry?.description ?? `${input.words?.Appointment ?? "Appointment"} with ${input.practitionerName}. For changes, contact ${input.clinicName} at ${input.clinicPhone}.`)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  return `${lines.flatMap(foldCalendarLine).join("\r\n")}\r\n`;
}

export interface FeedEvent {
  appointmentId: string;
  version: number;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  /** Already shaped by the business's privacy setting. */
  summary: string;
  description?: string;
  location?: string;
}

/** A subscribe-only calendar of one staff member's appointments (feature 16). Text is whatever the caller allows. */
export function createFeedCalendar(events: readonly FeedEvent[], generatedAt = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Kalendr//Staff Feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Kalendr",
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    "X-PUBLISHED-TTL:PT15M",
    ...events.flatMap((event) => [
      "BEGIN:VEVENT",
      `UID:${escapeCalendarText(`${event.appointmentId}@kalendr.app`)}`,
      `DTSTAMP:${formatCalendarDate(generatedAt)}`,
      `DTSTART:${formatCalendarDate(new Date(event.startsAt))}`,
      `DTEND:${formatCalendarDate(new Date(event.endsAt))}`,
      `SEQUENCE:${Math.max(0, event.version)}`,
      `STATUS:${calendarStatus(event.status)}`,
      `SUMMARY:${escapeCalendarText(event.summary)}`,
      ...(event.location ? [`LOCATION:${escapeCalendarText(event.location)}`] : []),
      ...(event.description ? [`DESCRIPTION:${escapeCalendarText(event.description)}`] : []),
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ];
  return `${lines.flatMap(foldCalendarLine).join("\r\n")}\r\n`;
}

function formatCalendarDate(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new Error("Cannot create a calendar event from an invalid date.");
  }

  return date
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
}

const escapeCalendarText = escapeIcsText;

function calendarStatus(status: AppointmentStatus): "CONFIRMED" | "TENTATIVE" | "CANCELLED" {
  if (status === "cancelled" || status === "entered_in_error" || status === "declined" || status === "expired") {
    return "CANCELLED";
  }
  return status === "requested" ? "TENTATIVE" : "CONFIRMED";
}

function foldCalendarLine(line: string): string[] {
  const maximumOctets = 75;
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= maximumOctets) return [line];

  let prefix = "";
  let segment = "";
  const segments: string[] = [];
  for (const character of line) {
    if (
      segment &&
      encoder.encode(`${prefix}${segment}${character}`).length > maximumOctets
    ) {
      segments.push(`${prefix}${segment}`);
      prefix = " ";
      segment = character;
      continue;
    }
    segment += character;
  }
  segments.push(`${prefix}${segment}`);
  return segments;
}
