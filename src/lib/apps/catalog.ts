import { z } from "zod";

import type { WebhookEventType } from "../api-scopes";

/**
 * The Apps page's shapes (feature 55). Browser-safe: nothing here reaches a database or a secret. The server builds
 * these from the registry in code; the page only draws them.
 */

export const appCategories = ["messaging", "crm", "analytics", "website", "calendar", "video", "payments", "developer"] as const;
export type AppCategory = (typeof appCategories)[number];

export const appCategoryLabels: Record<AppCategory, string> = {
  messaging: "Messaging",
  crm: "Customer records",
  analytics: "Analytics",
  website: "Website",
  calendar: "Calendars",
  video: "Video",
  payments: "Payments",
  developer: "For developers",
};

/** One input the owner fills in when an app is installed or its settings change. */
export type SettingField =
  | { kind: "text"; key: string; label: string; help?: string; placeholder?: string; maxLength: number }
  | { kind: "switch"; key: string; label: string; help?: string }
  /** A set of choices, saved as a list of their values. */
  | { kind: "choices"; key: string; label: string; help?: string; options: { value: string; label: string; help?: string }[] }
  /** Rows the owner turns on or off, each naming where it goes in the other system. Saved as `{ [row]: { enabled, target } }`. */
  | { kind: "mapping"; key: string; label: string; help?: string; rows: { key: string; label: string; locked?: boolean; defaultTarget: string }[] };

export interface CredentialField {
  key: string;
  label: string;
  help: string;
  placeholder: string;
}

export type AppState = "available" | "active" | "paused" | "failing" | "uninstalling" | "connected" | "not_connected" | "unavailable";

/** An app that installs from this page, or an existing connection that is managed in its own settings. */
export interface AppCard {
  key: string;
  name: string;
  tagline: string;
  category: AppCategory;
  /** `native` apps install here; `connected` ones are the integrations built earlier, listed so they are found in one place. */
  kind: "native" | "connected";
  state: AppState;
  /** One plain sentence about what is going on right now, such as "3 calendars connected". */
  statusText: string | null;
  /** What it sends or reads, in plain words. Shown before install. */
  dataSent: string[];
  /** For a connected integration: the settings section that manages it, and what the button says. */
  manage: { section?: string; href?: string; label: string } | null;
  /** True when the plan does not include it. */
  needsUpgrade: boolean;
}

export interface AppEventView {
  id: string;
  eventType: string;
  outcome: "delivered" | "failed" | "skipped";
  errorCode: string | null;
  createdAt: string;
}

export interface AppDetail extends AppCard {
  description: string;
  credentialFields: CredentialField[];
  settingFields: SettingField[];
  /** Saved choices. Never a secret. */
  settings: Record<string, unknown>;
  hasCredentials: boolean;
  version: number | null;
  installedAt: string | null;
  disabledReason: string | null;
  /** What to do outside Kalendr when the app is removed, for example "Delete the token in HubSpot". */
  uninstallNote: string | null;
  events: AppEventView[];
}

/** Fixed codes a delivery can end with, and what each means to a receptionist. */
export const appErrorMessages: Record<string, string> = {
  credential_rejected: "The other service no longer accepts the saved key. Replace it.",
  destination_missing: "The place it posts to was not found or Kalendr is not allowed in.",
  rate_limited: "The other service asked Kalendr to slow down. It will try again.",
  service_unavailable: "The other service is not answering. It will try again.",
  rejected: "The other service refused the update.",
  timeout: "The other service took too long to answer.",
  connection_failed: "Kalendr could not reach the other service.",
  blocked_address: "The address is not allowed.",
  tls_error: "The other service's security certificate was not accepted.",
  no_email: "Skipped: the customer has no email address.",
  no_consent: "Skipped: the customer has not agreed to be contacted for marketing.",
  nothing_to_send: "Skipped: no fields were turned on.",
  not_subscribed: "Skipped: this app is not set to hear about that.",
  revoke_failed: "The key could not be revoked at the other service. Remove it there yourself.",
  app_inactive: "Skipped: the app was switched off.",
};

export const installAppInput = z.object({
  credentials: z.record(z.string(), z.string().max(400)),
  settings: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type InstallAppInput = z.infer<typeof installAppInput>;

export const updateAppInput = z.object({
  settings: z.record(z.string(), z.unknown()),
  expectedVersion: z.number().int().min(1),
}).strict();
export type UpdateAppInput = z.infer<typeof updateAppInput>;

export const replaceCredentialsInput = z.object({
  credentials: z.record(z.string(), z.string().max(400)),
  expectedVersion: z.number().int().min(1),
}).strict();

export const appStatusInput = z.object({
  status: z.enum(["active", "paused"]),
  expectedVersion: z.number().int().min(1),
}).strict();

/** The events an app can listen for. The same names as webhooks, so one vocabulary covers both. */
export const appEventLabels: Partial<Record<WebhookEventType, string>> = {
  "appointment.created": "A new booking",
  "appointment.rescheduled": "A booking moved",
  "appointment.cancelled": "A booking cancelled",
  "appointment.completed": "A visit finished",
  "appointment.no_show": "Someone did not turn up",
  "customer.created": "A new customer",
};
