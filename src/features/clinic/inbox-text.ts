import type { ThreadMessageStatus } from "@/lib/inbox-contracts";

import { appointmentDay, appointmentTime } from "./clinic-format";

/** The business's day, as the existing format helpers use it. Same-day messages show a time, older ones a date. */
function dayKey(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(iso));
}

export function shortWhen(iso: string, now: Date = new Date()): string {
  return dayKey(iso) === dayKey(now.toISOString()) ? appointmentTime(iso) : appointmentDay(iso);
}

export function dayHeading(iso: string, now: Date = new Date()): string {
  if (dayKey(iso) === dayKey(now.toISOString())) return "Today";
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return "Yesterday";
  return appointmentDay(iso);
}

export { dayKey };

/** What a delivery state means, in words. Never colour alone: the label is always shown. */
export const statusWords: Record<ThreadMessageStatus, string> = {
  received: "Received",
  queued: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  failed: "Not delivered",
};

/** The worker stores short codes only; this turns them into a sentence staff can act on. */
export function failureWords(code: string | null): string {
  switch (code) {
    case "window_closed": return "It was more than 24 hours since they wrote, so WhatsApp refused a free-form message. Send an approved template instead.";
    case "provider_not_configured": return "Kalendr's WhatsApp number isn't connected yet, so nothing could be sent.";
    case "not_on_whatsapp": return "This number isn't on WhatsApp.";
    case "opted_out": return "They asked not to get messages, so none are sent.";
    case "template_not_approved": return "WhatsApp hasn't approved this template yet.";
    case null: return "WhatsApp could not deliver it.";
    default: return "WhatsApp could not deliver it.";
  }
}
