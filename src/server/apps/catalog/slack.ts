import { z } from "zod";

import type { WebhookEventType } from "../../../lib/api-scopes";
import { verdictForStatus, type AppDefinition, type AppRequest, type DeliveryFacts, type Verdict } from "../types";

/**
 * Slack (feature 55): posts a short line to one channel when a booking is made, moved or cancelled. It uses a bot token
 * the owner makes in their own Slack workspace, so Kalendr holds no Slack app of its own to approve.
 */

const events = ["appointment.created", "appointment.rescheduled", "appointment.cancelled"] as const satisfies readonly WebhookEventType[];

const settingsSchema = z.object({
  channel: z.string().trim().regex(/^(#?[a-z0-9][a-z0-9_-]{0,79}|[CG][A-Z0-9]{8,})$/, "Use a channel name such as #bookings, or its channel id."),
  events: z.array(z.enum(events)).min(1, "Choose at least one thing to post.").max(events.length),
  showFirstName: z.boolean(),
}).strict();
type SlackSettings = z.infer<typeof settingsSchema>;

const credentialSchema = z.object({
  botToken: z.string().trim().regex(/^xoxb-[A-Za-z0-9-]{20,200}$/, "That does not look like a Slack bot token. It starts with xoxb-."),
}).strict();

const API = "https://slack.com/api";

function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function when(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: timezone }).format(new Date(iso));
}

function headers(token: string): Record<string, string> {
  return { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` };
}

function post(token: string, channel: string, text: string): AppRequest {
  return { url: `${API}/chat.postMessage`, method: "POST", headers: headers(token), body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }) };
}

const verbs: Partial<Record<WebhookEventType, string>> = {
  "appointment.created": "New booking",
  "appointment.rescheduled": "Booking moved",
  "appointment.cancelled": "Booking cancelled",
};

export function slackLine(type: string, startsAt: string, facts: DeliveryFacts, showFirstName: boolean): string {
  const service = escapeSlack(facts.serviceName ?? "Appointment");
  const who = showFirstName && facts.customer ? ` for ${escapeSlack(facts.customer.firstName)}` : "";
  return `${verbs[type as WebhookEventType] ?? "Booking update"}: ${service}${who}, ${when(startsAt, facts.timezone)}`;
}

function interpret({ statusCode, body }: { statusCode: number; body: string }): Verdict {
  if (statusCode < 200 || statusCode >= 300) return verdictForStatus(statusCode);
  let reply: { ok?: unknown; error?: unknown };
  try {
    const parsed: unknown = JSON.parse(body);
    reply = typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return { ok: false, code: "rejected", retry: false };
  }
  if (reply.ok === true) return { ok: true };
  const error = typeof reply.error === "string" ? reply.error : "";
  if (["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"].includes(error)) return { ok: false, code: "credential_rejected", retry: false, credential: true };
  if (["channel_not_found", "not_in_channel", "is_archived", "restricted_action"].includes(error)) return { ok: false, code: "destination_missing", retry: false };
  if (["ratelimited", "rate_limited"].includes(error)) return { ok: false, code: "rate_limited", retry: true };
  if (["fatal_error", "internal_error", "service_unavailable", "request_timeout"].includes(error)) return { ok: false, code: "service_unavailable", retry: true };
  return { ok: false, code: "rejected", retry: false };
}

export const slackApp: AppDefinition<SlackSettings> = {
  key: "slack",
  name: "Slack",
  tagline: "Post new bookings to a channel.",
  description: "Your team sees each new, moved and cancelled booking in a Slack channel the moment it happens, so nobody has to keep the calendar open.",
  category: "messaging",
  dataSent: [
    "The service name and the date and time of the booking.",
    "The customer's first name, only if you turn that on. Never a surname, phone number or email.",
  ],
  allowedHosts: ["slack.com"],
  credentialFields: [{
    key: "botToken", label: "Slack bot token", placeholder: "xoxb-…",
    help: "In Slack, make an app for your workspace, add the chat:write permission, install it, and copy the Bot User OAuth Token. Then add the app to the channel.",
  }],
  credentialSchema,
  settingFields: [
    { kind: "text", key: "channel", label: "Channel", placeholder: "#bookings", maxLength: 81, help: "Where the lines are posted. Add the app to this channel in Slack first." },
    { kind: "choices", key: "events", label: "Post when", options: [
      { value: "appointment.created", label: "A new booking" },
      { value: "appointment.rescheduled", label: "A booking moves" },
      { value: "appointment.cancelled", label: "A booking is cancelled" },
    ] },
    { kind: "switch", key: "showFirstName", label: "Include the customer's first name", help: "Off by default. Anyone in the channel will see it." },
  ],
  settingsSchema,
  defaultSettings: { channel: "#bookings", events: ["appointment.created", "appointment.cancelled"], showFirstName: false },
  events,
  uninstallNote: "Kalendr revokes the token in Slack for you. You can also remove the app from your Slack workspace.",
  listensTo: (settings) => settings.events,
  needsCustomer: (settings) => settings.showFirstName,
  build({ event, settings, credentials, facts }) {
    if (event.type === "webhook.test" || !settings.events.some((type) => type === event.type)) return { skip: "not_subscribed" };
    if (!("startsAt" in event.data)) return { skip: "not_subscribed" };
    return { request: post(credentials.botToken ?? "", settings.channel, slackLine(event.type, event.data.startsAt, facts, settings.showFirstName)) };
  },
  buildCheck: ({ settings, credentials, businessName }) =>
    post(credentials.botToken ?? "", settings.channel, `Kalendr is connected. Bookings for ${escapeSlack(businessName)} will be posted here.`),
  interpret,
  buildRevoke: (credentials) => ({ url: `${API}/auth.revoke`, method: "POST", headers: headers(credentials.botToken ?? ""), body: "{}" }),
};
