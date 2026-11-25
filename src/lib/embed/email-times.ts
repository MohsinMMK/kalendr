import { attribute } from "./builder";

/**
 * "Times for an email" (feature 52): plain HTML of a few open times, each linking to the booking page with that time chosen.
 * It is a snapshot. The booking page checks the time again, so a link to a time that was taken since just shows what is left.
 */
export interface EmailTime {
  startsAt: string;
  /** "Tue 24 Nov, 4:30 pm", in the business's own time zone. */
  label: string;
  href: string;
}

export const EMAIL_TIME_COUNT = 6;

export function formatEmailTime(startsAt: Date, timeZone: string, locale = "en-IN"): string {
  const day = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone }).format(startsAt).replace(/,/g, "");
  const clock = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).format(startsAt).toLowerCase();
  return `${day}, ${clock}`;
}

/** The calendar day of a moment in a time zone, "YYYY-MM-DD", which the booking page's `date` parameter wants. */
export function dayInZone(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export function emailTimesHtml(businessName: string, serviceName: string, times: EmailTime[], bookingPage: string): string {
  const rows = times.map((time) =>
    `    <li style="margin:0 0 8px"><a href="${attribute(time.href)}" style="color:#1d4ed8">${attribute(time.label)}</a></li>`);
  return [
    `<p style="margin:0 0 8px">Times open for ${attribute(serviceName)} at ${attribute(businessName)}:</p>`,
    `<ul style="margin:0 0 12px;padding-left:20px">`,
    ...rows,
    `</ul>`,
    `<p style="margin:0">Need another time? <a href="${attribute(bookingPage)}" style="color:#1d4ed8">See all open times</a>.</p>`,
  ].join("\n");
}
