/** What a calendar event needs: the times, a title, where it is, and a note with the manage link. */
export interface CalendarEvent {
  title: string;
  startsAt: string;
  endsAt: string;
  location?: string;
  details?: string;
}

/** "20261112T043000Z", the compact UTC form Google Calendar reads. */
function compactUtc(value: string): string {
  return new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** A Google Calendar link that opens a new event already filled in. */
export function googleCalendarHref(event: CalendarEvent): string {
  const query = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates: `${compactUtc(event.startsAt)}/${compactUtc(event.endsAt)}`,
  });
  if (event.details) query.set("details", event.details);
  if (event.location) query.set("location", event.location);
  return `https://calendar.google.com/calendar/render?${query}`;
}

/** An Outlook.com link that opens a new event already filled in. */
export function outlookComHref(event: CalendarEvent): string {
  const query = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: event.title,
    startdt: new Date(event.startsAt).toISOString(),
    enddt: new Date(event.endsAt).toISOString(),
  });
  if (event.details) query.set("body", event.details);
  if (event.location) query.set("location", event.location);
  return `https://outlook.live.com/calendar/0/action/compose?${query}`;
}

/** The calendar file (.ics) link for a booking, for Apple Calendar and desktop Outlook. */
export function calendarFileHref(manageToken: string): string {
  return `/api/public/appointments/${encodeURIComponent(manageToken)}/calendar`;
}

/** The event for a booking, in the business's words. */
export function bookingCalendarEvent(input: {
  serviceName: string;
  businessName: string;
  startsAt: string;
  endsAt: string;
  personName?: string;
  location?: { name: string; address?: string; city?: string };
  manageUrl?: string;
  manageLabel?: string;
}): CalendarEvent {
  const place = input.location
    ? [input.location.name, input.location.address, input.location.city].filter(Boolean).join(", ")
    : undefined;
  const details = [
    input.personName ? `With ${input.personName}` : undefined,
    input.manageUrl ? `${input.manageLabel ?? "Manage your booking"}: ${input.manageUrl}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    title: `${input.serviceName} at ${input.businessName}`,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    ...(place ? { location: place } : {}),
    ...(details ? { details } : {}),
  };
}
