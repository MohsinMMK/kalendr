import type { Today } from "./schemas";

/** Small, pure helpers the popup uses. Kept apart from React so they can be tested alone. */

/** "10:30 am" in the business's own time zone, not the browser's, because staff read the day the way the business does. */
export function timeIn(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: timezone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  }
}

export function dayLabel(date: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: timezone }).format(new Date(`${date}T12:00:00Z`));
  } catch {
    return date;
  }
}

export const statusWords: Record<string, string> = {
  requested: "Waiting for approval", booked: "Booked", checked_in: "Arrived", completed: "Done",
};

export function bookingLine(booking: Today["bookings"][number], timezone: string): { time: string; who: string; what: string; status: string } {
  return { time: timeIn(booking.startsAt, timezone), who: booking.firstName, what: booking.serviceName, status: statusWords[booking.status] ?? "Booked" };
}

/** The plain-text twin of the email snippet, for apps that do not take pasted HTML. */
export function timesAsText(serviceName: string, times: { label: string; href: string }[], page: string): string {
  return [`Times for ${serviceName}:`, ...times.map((time) => `- ${time.label}: ${time.href}`), `More times: ${page}`].join("\n");
}

/** A person may paste a key with spaces or a line break around it. */
export function tidyKey(value: string): string {
  return value.replace(/\s+/g, "");
}

export function matches(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle.trim().toLowerCase());
}
