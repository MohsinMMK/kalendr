/**
 * Which approved template (WhatsApp or SMS) an appointment event uses. WhatsApp and SMS only
 * send approved wording, so an event with no template here goes by email instead.
 */
export type ChannelTemplateKey =
  | "booking_confirmed"
  | "reminder"
  | "rescheduled"
  | "cancelled"
  | "waitlist_offer"
  | "series_confirmed"
  | "review_request"
  | "sign_in_code"
  | "contact_changed";

export function channelTemplateFor(eventType: string): ChannelTemplateKey | null {
  switch (eventType) {
    case "appointment.created":
    case "appointment.confirm":
    case "appointment.status.booked":
      return "booking_confirmed";
    case "appointment.reminder":
      return "reminder";
    case "appointment.reschedule":
    case "appointment.suggest":
      return "rescheduled";
    case "appointment.cancel":
    case "appointment.status.cancelled":
      return "cancelled";
    case "appointment.review_request":
      return "review_request";
    case "waitlist.offer":
      return "waitlist_offer";
    case "series.confirmation":
      return "series_confirmed";
    default:
      return null;
  }
}

/** SMS has no review request, waitlist offer or series confirmation: those stay on WhatsApp and email. */
export const smsTemplateKeys: ReadonlySet<ChannelTemplateKey> = new Set(["booking_confirmed", "reminder", "rescheduled", "cancelled", "sign_in_code", "contact_changed"]);

/** The approved templates staff can send as a reply once the 24-hour window has closed. They need a booking to fill in. */
export const replyTemplateKeys = ["reminder", "booking_confirmed", "rescheduled"] as const;
