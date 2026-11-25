import type { Appointment, BookingSource } from "@/lib/domain";

export const bookingSourceLabels: Record<BookingSource, string> = {
  online: "Booking page",
  widget: "Website button",
  iframe: "Website embed",
  phone: "Phone call",
  staff: "Front desk",
  walk_in: "Walk-in",
  recall: "Recall",
  waitlist: "Waitlist",
  assistant: "Booking assistant",
};

/** "Booking page · from google.com · spring-cleaning" — where the visit came from, in one line. */
export function bookingOriginLine(appointment: Pick<Appointment, "bookingSource" | "referrerHost" | "utm">): string {
  const parts = [bookingSourceLabels[appointment.bookingSource]];
  if (appointment.referrerHost) parts.push(`from ${appointment.referrerHost}`);
  const campaign = appointment.utm?.campaign ?? appointment.utm?.source;
  if (campaign) parts.push(campaign);
  return parts.join(" · ");
}
