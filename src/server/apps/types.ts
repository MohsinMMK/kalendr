import type { z } from "zod";

import type { AppCategory, CredentialField, SettingField } from "../../lib/apps/catalog";
import type { WebhookEventType } from "../../lib/api-scopes";
import type { WebhookEnvelope } from "../webhooks/payloads";

/**
 * What an app is (feature 55). An app is a module that describes itself and turns an event into one outgoing request;
 * it never makes the call. The worker owns sending, retries, the activity log and switching an app off when it keeps
 * failing, so a new app cannot get any of those wrong. Nothing here imports a database or a framework.
 */

export type AppCredentials = Record<string, string>;

export interface AppRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

/** The facts an app may use to word or fill a request. Loaded by the worker, only as far as the app asks. */
export interface DeliveryFacts {
  serviceName: string | null;
  /** The business's time zone, for wording times the way its staff read them. */
  timezone: string;
  /** Present only when the app asked for it with `needsCustomer`. */
  customer: { firstName: string; lastName: string; email: string | null; phone: string | null; marketingConsent: boolean } | null;
}

export interface DeliveryInput<Settings> {
  event: WebhookEnvelope;
  settings: Settings;
  credentials: AppCredentials;
  facts: DeliveryFacts;
}

export type SkipCode = "no_email" | "no_consent" | "nothing_to_send" | "not_subscribed";

export type BuildResult = { request: AppRequest } | { skip: SkipCode };

export type Verdict =
  | { ok: true }
  /** `credential` means the saved key was refused: retrying will not help, so the app is switched off until it is replaced. */
  | { ok: false; code: string; retry: boolean; credential?: boolean };

export interface AppDefinition<Settings extends Record<string, unknown> = Record<string, unknown>> {
  key: string;
  name: string;
  tagline: string;
  description: string;
  category: AppCategory;
  /** What the app sends, in plain words, shown before install. */
  dataSent: string[];
  /** Outgoing requests may only go to these hosts. A bug or a bad setting cannot point an app anywhere else. */
  allowedHosts: readonly string[];
  credentialFields: CredentialField[];
  credentialSchema: z.ZodType<AppCredentials>;
  settingFields: SettingField[];
  settingsSchema: z.ZodType<Settings>;
  defaultSettings: Settings;
  /** Public event names the app may listen for. Which of them it does is the owner's choice in its settings. */
  events: readonly WebhookEventType[];
  /** True when, with these settings, a request needs the customer's details. The worker loads them only then. */
  needsCustomer?(settings: Settings): boolean;
  /** What the owner must do outside Kalendr after removal, when the other service has no way to revoke from here. */
  uninstallNote?: string;
  listensTo(settings: Settings): readonly WebhookEventType[];
  build(input: DeliveryInput<Settings>): BuildResult;
  /** A harmless request that proves the saved key and settings work. */
  buildCheck(input: { settings: Settings; credentials: AppCredentials; facts: DeliveryFacts; businessName: string }): AppRequest;
  interpret(response: { statusCode: number; body: string }): Verdict;
  /** A request that revokes the saved key at the other service, when it offers a way. */
  buildRevoke?(credentials: AppCredentials): AppRequest;
}

/** Shared by every app: how a plain HTTP status reads when the app has no finer rule. */
export function verdictForStatus(statusCode: number): Verdict {
  if (statusCode >= 200 && statusCode < 300) return { ok: true };
  if (statusCode === 401 || statusCode === 403) return { ok: false, code: "credential_rejected", retry: false, credential: true };
  if (statusCode === 404) return { ok: false, code: "destination_missing", retry: false };
  if (statusCode === 429) return { ok: false, code: "rate_limited", retry: true };
  if (statusCode >= 500) return { ok: false, code: "service_unavailable", retry: true };
  return { ok: false, code: "rejected", retry: false };
}

/**
 * An app as the framework runs it. The author's typed settings are checked here, once, so the install code and the
 * worker deal in plain values and a row whose settings no longer fit the schema is skipped, not sent.
 */
export interface RegisteredApp {
  key: string;
  name: string;
  tagline: string;
  description: string;
  category: AppCategory;
  dataSent: string[];
  allowedHosts: readonly string[];
  credentialFields: CredentialField[];
  credentialSchema: z.ZodType<AppCredentials>;
  settingFields: SettingField[];
  defaultSettings: Record<string, unknown>;
  events: readonly WebhookEventType[];
  uninstallNote: string | null;
  hasRevoke: boolean;
  parseSettings(value: unknown): { ok: true; settings: Record<string, unknown> } | { ok: false; fieldErrors: Record<string, string[]> };
  listensTo(settings: unknown): readonly WebhookEventType[];
  needsCustomer(settings: unknown): boolean;
  build(input: Omit<DeliveryInput<unknown>, "settings"> & { settings: unknown }): BuildResult;
  buildCheck(input: { settings: unknown; credentials: AppCredentials; facts: DeliveryFacts; businessName: string }): AppRequest | null;
  interpret(response: { statusCode: number; body: string }): Verdict;
  buildRevoke(credentials: AppCredentials): AppRequest | null;
}
