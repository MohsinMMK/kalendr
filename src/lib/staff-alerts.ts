import { z } from "zod";

import type { Permission } from "@/lib/permissions";
import type { TermWords } from "@/lib/terminology";

/**
 * The alerts staff can get. The list is open on purpose: a new feature adds a kind here and calls
 * `notifyStaff` with it. A kind stored in the database that this list no longer knows still shows
 * in the bell; it just has no preference switch.
 */
export const alertKinds = [
  "new_booking",
  "booking_request",
  "message",
  "cancellation",
  "payment",
  "waitlist_filled",
  "needs_person",
  "booking_moved",
  "rescheduled",
  "low_rating",
] as const;

export type AlertKind = (typeof alertKinds)[number];

export function isAlertKind(value: string): value is AlertKind {
  return (alertKinds as readonly string[]).includes(value);
}

/** Who may hear about a kind. Someone who could not open the thing the alert is about gets no alert. */
export const alertPermissions: Record<AlertKind, readonly Permission[]> = {
  new_booking: ["appointments.book", "appointments.status"],
  booking_request: ["appointments.book"],
  message: ["inbox.reply"],
  cancellation: ["appointments.book", "appointments.status"],
  payment: ["payments.collect", "payments.refund"],
  waitlist_filled: ["appointments.book"],
  needs_person: ["appointments.book", "appointments.status"],
  booking_moved: ["appointments.book", "appointments.status"],
  rescheduled: ["appointments.book", "appointments.status"],
  low_rating: ["appointments.book", "appointments.status"],
};

export function mayReceiveAlert(permissions: readonly Permission[], kind: AlertKind): boolean {
  return alertPermissions[kind].some((permission) => permissions.includes(permission));
}

/** What a preference switch is called, in the business's own words. */
export function alertKindLabels(t: TermWords): Record<AlertKind, { label: string; description: string }> {
  return {
    new_booking: { label: `New online ${t.appointment}`, description: `A ${t.customer} books on your page.` },
    booking_request: { label: `${t.Appointment} request to approve`, description: `A ${t.customer} asks for a time and it needs your yes.` },
    message: { label: `${t.Customer} message`, description: `A ${t.customer} writes to you.` },
    cancellation: { label: "Cancellation", description: `A ${t.customer} cancels online.` },
    payment: { label: "Payment received", description: "Money is recorded at the desk." },
    waitlist_filled: { label: "Waitlist filled", description: `Someone on the waitlist gets ${t.anAppointment}.` },
    needs_person: { label: "Needs a person", description: "Something the system could not finish by itself." },
    booking_moved: { label: `${t.Appointment} given to someone else`, description: `A ${t.appointment} you had, or now have, was reassigned.` },
    rescheduled: { label: `${t.Appointment} moved`, description: `A ${t.customer} moves their ${t.appointment} online.` },
    low_rating: { label: "Low rating", description: `A ${t.customer} leaves a review of 1 or 2 stars.` },
  };
}

/** The path an alert opens: this app only, so a stored link can never lead off-site. */
export function appointmentLink(appointmentId: string): string {
  return `/schedule?open=${encodeURIComponent(appointmentId)}`;
}

export function isAppPath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && value.length <= 200;
}

export const notificationViewSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  link: z.string().nullable(),
  read: z.boolean(),
  at: z.string(),
});
export type NotificationView = z.infer<typeof notificationViewSchema>;

export const notificationListSchema = z.object({
  items: z.array(notificationViewSchema),
  unread: z.number().int().min(0),
});
export type NotificationList = z.infer<typeof notificationListSchema>;

export const preferenceViewSchema = z.object({
  kind: z.string(),
  inApp: z.boolean(),
  push: z.boolean(),
  email: z.boolean(),
});
export type PreferenceView = z.infer<typeof preferenceViewSchema>;

/** The push address a browser gives us. Always https, and never a private address, because the worker posts to it. */
export const pushSubscriptionInputSchema = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(1_000).refine(isPublicHost, "That address cannot be used."),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{60,100}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{16,40}$/),
  }),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionInputSchema>;

export function isPublicHost(endpoint: string): boolean {
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (!host.includes(".") && !host.includes(":")) return false;
  if (host.startsWith("[") || host.includes(":")) return false;
  const parts = host.split(".");
  if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part))) return false;
  return true;
}

/** "4:30 pm", or "Tue 24 Nov, 4:30 pm" when it is not today, in the business's own time zone. */
export function alertTime(at: Date, timeZone: string, now: Date = new Date()): string {
  const clock = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).format(at).toLowerCase();
  const dayKey = (value: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
  if (dayKey(at) === dayKey(now)) return clock;
  const day = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone }).format(at).replace(/,/g, "");
  return `${day}, ${clock}`;
}

/** Short and free of names and contact details, so it is safe on a lock screen. */
export function alertTitle(kind: AlertKind, when?: string): string {
  switch (kind) {
    case "new_booking": return when ? `New booking at ${when}` : "New booking";
    case "booking_request": return when ? `Booking request for ${when}` : "New booking request";
    case "cancellation": return when ? `Booking for ${when} was cancelled` : "A booking was cancelled";
    case "payment": return "Payment received";
    case "waitlist_filled": return when ? `A waitlist spot was filled for ${when}` : "A waitlist spot was filled";
    case "message": return "New message";
    case "needs_person": return "Something needs a person";
    case "booking_moved": return when ? `A booking at ${when} was reassigned` : "A booking was reassigned";
    case "rescheduled": return when ? `A booking was moved to ${when}` : "A booking was moved";
    case "low_rating": return "A low rating came in";
  }
}

/** What the worker sends: short text and a path inside the app. No names, no contact details. */
export const pushJobSchema = z.object({
  membershipId: z.string().min(1).optional(),
  patientId: z.string().min(1).optional(),
  title: z.string().min(1).max(140),
  body: z.string().max(140).optional(),
  link: z.string().refine(isAppPath).optional(),
  kind: z.string().max(40),
}).refine((job) => Boolean(job.membershipId) !== Boolean(job.patientId), "A push goes to one staff member or one customer.");
export type PushJob = z.infer<typeof pushJobSchema>;

/** The stored, unsealed subscription. */
export const storedSubscriptionSchema = z.object({
  endpoint: z.string().url().max(1_000),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});
export type StoredSubscription = z.infer<typeof storedSubscriptionSchema>;

/** What the service worker receives in a push event. */
export const pushMessageSchema = z.object({
  title: z.string().max(140),
  body: z.string().max(140).optional(),
  link: z.string().refine(isAppPath).optional(),
  kind: z.string().max(40).optional(),
});
export type PushMessage = z.infer<typeof pushMessageSchema>;

/** The purpose a push address is sealed for (src/server/keys/secrets.ts). The web app seals it and the worker opens it with the same word. */
export const PUSH_SECRET_PURPOSE = "push.subscription";

/** What a push or an email says under the title: the customer's first name, the service and the time. Never a phone, email or note. */
export function alertDetail(parts: { firstName?: string | null; service?: string | null; when?: string | null }): string | undefined {
  const text = [parts.firstName, parts.service, parts.when].map((part) => part?.trim()).filter((part): part is string => Boolean(part)).join(" · ");
  return text ? text.slice(0, 140) : undefined;
}

/** One alert as an email (feature 56). The worker sends it to the person's own sign-in address. */
export const STAFF_EMAIL_EVENT = "staff.email";
export const staffEmailJobSchema = z.object({
  membershipId: z.string().min(1),
  kind: z.string().max(40),
  title: z.string().min(1).max(140),
  body: z.string().max(140).optional(),
  link: z.string().refine(isAppPath).optional(),
});
export type StaffEmailJob = z.infer<typeof staffEmailJobSchema>;

/** One person's morning email: what is on today, what is waiting, and yesterday's cancellations. */
export const STAFF_DIGEST_EVENT = "staff.digest";
const digestLine = z.object({ time: z.string().max(40), service: z.string().max(160), firstName: z.string().max(80) });
export const staffDigestSchema = z.object({
  membershipId: z.string().min(1),
  /** The business's local day, "2026-11-20". */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  today: z.array(digestLine).max(60),
  todayCount: z.number().int().min(0),
  waiting: z.number().int().min(0),
  cancelled: z.array(digestLine).max(30),
});
export type StaffDigest = z.infer<typeof staffDigestSchema>;
