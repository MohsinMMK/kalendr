import type { BookingSource } from "./domain";

export type BookingOrigin = BookingSource;
export type NotificationChannel = "sms" | "email" | "whatsapp";

/** Patients who booked on the website can also see the change on their private booking page. */
export function bookedOnWebsite(origin: BookingOrigin): boolean {
  return origin === "online" || origin === "widget" || origin === "iframe";
}

/** What can carry a message right now: the business switched it on and a provider is set up. */
export interface ChannelAvailability {
  whatsapp: boolean;
  sms: boolean;
}

const everythingOn: ChannelAvailability = { whatsapp: true, sms: true };

/**
 * Where a message goes. Email is always possible. WhatsApp and SMS need the customer's consent,
 * must be what they asked for ("phone" means text, since nobody can auto-call), and must be
 * switched on and set up. When the one they asked for can't be used the order is WhatsApp, then
 * SMS, then email, so a customer who agreed to messages still hears something on a channel
 * that works. `origin` no longer matters: a website booking records the customer's own choice.
 */
export function notificationChannel(
  _origin: BookingOrigin,
  preferred: NotificationChannel | "phone",
  messagingConsent = true,
  available: ChannelAvailability = everythingOn,
): NotificationChannel {
  if (preferred === "email" || !messagingConsent) return "email";
  const wanted: NotificationChannel = preferred === "phone" ? "sms" : preferred;
  const order: NotificationChannel[] = wanted === "whatsapp" ? ["whatsapp", "sms"] : ["sms"];
  return order.find((channel) => available[channel as "whatsapp" | "sms"]) ?? "email";
}
