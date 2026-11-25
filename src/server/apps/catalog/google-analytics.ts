import { createHash } from "node:crypto";

import { z } from "zod";

import type { WebhookEventType } from "../../../lib/api-scopes";
import { verdictForStatus, type AppDefinition, type AppRequest } from "../types";

/**
 * Google Analytics (feature 55): sends a booking as a server-side event through Google's Measurement Protocol, so
 * confirmed bookings count even when a visitor blocked the browser tag. Events carry the service name and nothing
 * about the customer.
 */

const events = ["appointment.created", "appointment.rescheduled", "appointment.cancelled", "appointment.completed"] as const satisfies readonly WebhookEventType[];

const settingsSchema = z.object({
  measurementId: z.string().trim().regex(/^G-[A-Z0-9]{4,20}$/, "Use a measurement id such as G-ABC123DEF4."),
  events: z.array(z.enum(events)).min(1, "Choose at least one event to send.").max(events.length),
}).strict();
type GaSettings = z.infer<typeof settingsSchema>;

const credentialSchema = z.object({
  apiSecret: z.string().trim().regex(/^[A-Za-z0-9_-]{10,80}$/, "That does not look like a Measurement Protocol API secret."),
}).strict();

const names: Partial<Record<WebhookEventType, string>> = {
  "appointment.created": "booking_created",
  "appointment.rescheduled": "booking_rescheduled",
  "appointment.cancelled": "booking_cancelled",
  "appointment.completed": "visit_completed",
};

function collect(settings: GaSettings, secret: string, clientId: string, body: object): AppRequest {
  const query = new URLSearchParams({ measurement_id: settings.measurementId, api_secret: secret });
  return {
    url: `https://www.google-analytics.com/mp/collect?${query.toString()}`, method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: clientId, ...body }),
  };
}

export const googleAnalyticsApp: AppDefinition<GaSettings> = {
  key: "google-analytics",
  name: "Google Analytics",
  tagline: "Count confirmed bookings in Analytics.",
  description: "Sends a server-side event to Google Analytics 4 each time a booking is made, moved, cancelled or finished, so your reports show real bookings, not just page views.",
  category: "analytics",
  dataSent: [
    "An event name such as booking_created, and the name of the service.",
    "A random id that stands for the booking. No customer name, phone, email or notes.",
  ],
  allowedHosts: ["www.google-analytics.com"],
  credentialFields: [{
    key: "apiSecret", label: "Measurement Protocol API secret", placeholder: "Paste the secret",
    help: "In Analytics, open Admin, Data streams, your web stream, Measurement Protocol API secrets, and make one.",
  }],
  credentialSchema,
  settingFields: [
    { kind: "text", key: "measurementId", label: "Measurement id", placeholder: "G-ABC123DEF4", maxLength: 24, help: "Shown on your web data stream." },
    { kind: "choices", key: "events", label: "Send an event when", options: [
      { value: "appointment.created", label: "A booking is made" },
      { value: "appointment.rescheduled", label: "A booking moves" },
      { value: "appointment.cancelled", label: "A booking is cancelled" },
      { value: "appointment.completed", label: "A visit finishes" },
    ] },
  ],
  settingsSchema,
  defaultSettings: { measurementId: "", events: ["appointment.created"] },
  events,
  uninstallNote: "Google does not let Kalendr revoke the secret from here. Delete it under Measurement Protocol API secrets in Analytics to finish.",
  listensTo: (settings) => settings.events,
  build({ event, settings, credentials, facts }) {
    const name = names[event.type as WebhookEventType];
    const appointmentId = "appointmentId" in event.data ? event.data.appointmentId : null;
    if (!name || !appointmentId || !settings.events.some((type) => type === event.type)) return { skip: "not_subscribed" };
    // Hashed so the id Google keeps is not the id in our own data.
    const clientId = `kalendr.${createHash("sha256").update(appointmentId).digest("hex").slice(0, 20)}`;
    return {
      request: collect(settings, credentials.apiSecret ?? "", clientId, {
        events: [{ name, params: { service_name: facts.serviceName ?? "Appointment", engagement_time_msec: 1 } }],
      }),
    };
  },
  buildCheck: ({ settings, credentials }) => collect(settings, credentials.apiSecret ?? "", "kalendr.connection-check", {
    events: [{ name: "kalendr_connection_check", params: { engagement_time_msec: 1 } }],
  }),
  interpret: ({ statusCode }) => verdictForStatus(statusCode),
};
