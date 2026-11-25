/**
 * The contract every calendar adapter fulfils, and the shared zod-validated types the
 * database layer, worker and screens depend on. This layer is pure: no database, no
 * session, no secrets in logs.
 *
 * Privacy rule that shapes the whole design: what we read from someone's calendar is
 * only {id, start, end, cancelled, free}. Titles, descriptions, attendees and
 * locations are dropped inside the adapter and never appear in a returned value.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import type { FailureClass } from "./errors";

export const providerIdSchema = z.enum(["google", "microsoft", "apple"]);
export type ProviderId = z.infer<typeof providerIdSchema>;

const isoInstant = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "Expected an ISO timestamp");

/** Google and Microsoft: a refresh token we keep encrypted, plus the short-lived access token. */
export const oauthCredentialsSchema = z.object({
  kind: z.literal("oauth"),
  provider: z.enum(["google", "microsoft"]),
  refreshToken: z.string().min(1),
  accessToken: z.string().min(1).nullable().default(null),
  /** When the access token stops working. Null means unknown: refresh before use. */
  expiresAt: isoInstant.nullable().default(null),
});
export type OAuthCredentials = z.infer<typeof oauthCredentialsSchema>;

/** Apple iCloud (or any CalDAV server): an app-specific password, never the Apple ID password. */
export const caldavCredentialsSchema = z.object({
  kind: z.literal("caldav"),
  provider: z.literal("apple"),
  serverUrl: z.url(),
  username: z.string().min(1),
  appPassword: z.string().min(1),
});
export type CalDavCredentials = z.infer<typeof caldavCredentialsSchema>;

export const providerCredentialsSchema = z.discriminatedUnion("kind", [oauthCredentialsSchema, caldavCredentialsSchema]);
export type ProviderCredentials = z.infer<typeof providerCredentialsSchema>;

/** New tokens after a refresh. The consumer must persist these (encrypted) when the callback fires. */
export const refreshedTokensSchema = z.object({
  refreshToken: z.string().min(1),
  accessToken: z.string().min(1),
  expiresAt: isoInstant,
});
export type RefreshedTokens = z.infer<typeof refreshedTokensSchema>;

export interface OAuthExchangeResult extends RefreshedTokens {
  /** The account's sign-in address, shown as "Connected as ..." and nothing more. */
  accountEmail: string | null;
  /** Scopes actually granted. People can untick boxes on Google's consent screen. */
  grantedScopes: string[];
}

export interface CalendarInfo {
  id: string;
  name: string;
  primary: boolean;
  canWrite: boolean;
  /** IANA name when the provider tells us; null otherwise. */
  timezone: string | null;
}

/**
 * One external event reduced to what availability needs. `startsAt`/`endsAt` are UTC ISO
 * strings, and are null only for a cancelled event whose times the provider no longer sends.
 * There is deliberately no title, attendee, location or description field.
 */
export const busyEventSchema = z
  .object({
    sourceEventId: z.string().min(1),
    startsAt: isoInstant.nullable(),
    endsAt: isoInstant.nullable(),
    cancelled: z.boolean(),
    /** True when the owner marked it "free" (Google transparent, Outlook Free): it must not block slots. */
    transparent: z.boolean().optional(),
    allDay: z.boolean().optional(),
  })
  .strict();
export type BusyEvent = z.infer<typeof busyEventSchema>;

export interface SyncRequest {
  /** The token from the last sync of this calendar. Absent means a full read of the window. */
  syncToken?: string | null;
  /** Window for a full read. Incremental reads ignore it (the token carries the window). */
  from: Date;
  to: Date;
  /** Fallback zone for floating iCalendar times. Defaults to UTC. */
  timezone?: string;
}

/**
 * `snapshot`: these events are everything in the window; replace the cached rows for the
 * calendar. `delta`: apply these on top of the cache (cancelled = remove).
 * `fullResyncRequired`: the token was rejected; drop the cached rows and call again
 * without a token.
 */
export type SyncResult =
  | { fullResyncRequired: true }
  | {
      fullResyncRequired: false;
      mode: "snapshot" | "delta";
      events: BusyEvent[];
      /** Store this and send it next time. Null only if the provider gave none. */
      nextSyncToken: string | null;
      /** Recurrence rules we could not fully expand (CalDAV only); the rest are still included. */
      unsupportedRecurrences: number;
    };

export interface EventInput {
  title: string;
  description?: string;
  location?: string;
  /** UTC ISO instants. */
  start: string;
  end: string;
  /** IANA zone the event is shown in. */
  timezone: string;
  /**
   * Same key on a retry returns the same event instead of a duplicate. Use the outbox row id.
   */
  idempotencyKey?: string;
}

export interface EventWriteResult {
  eventId: string;
  /** For If-Match on the next change. Null if the provider did not return one. */
  etag: string | null;
}

export interface WriteOptions {
  /** Sent as If-Match. A mismatch throws `conflict`. */
  etag?: string | null;
}

export interface WatchChannel {
  channelId: string;
  /** Google needs this to stop the channel. */
  resourceId: string | null;
  expiresAt: string;
}

export interface WatchRequest {
  /** HTTPS webhook URL. */
  callbackUrl: string;
  /** Shared secret echoed back on every call (X-Goog-Channel-Token / clientState). */
  token: string;
}

export interface CalendarProvider {
  readonly id: ProviderId;
  /** False for CalDAV: poll every few minutes instead. */
  readonly supportsPush: boolean;

  /** Verifies the credentials work and returns the sign-in address, if the provider has one. */
  verifyAccount(credentials: ProviderCredentials): Promise<{ accountEmail: string | null }>;
  listCalendars(credentials: ProviderCredentials): Promise<CalendarInfo[]>;
  /** Read busy time: a full window read when `syncToken` is absent, otherwise only changes. */
  syncChanges(credentials: ProviderCredentials, calendarId: string, request: SyncRequest): Promise<SyncResult>;

  createEvent(credentials: ProviderCredentials, calendarId: string, input: EventInput): Promise<EventWriteResult>;
  updateEvent(
    credentials: ProviderCredentials,
    calendarId: string,
    eventId: string,
    input: EventInput,
    options?: WriteOptions,
  ): Promise<EventWriteResult>;
  /** A missing event counts as deleted. */
  deleteEvent(credentials: ProviderCredentials, calendarId: string, eventId: string, options?: WriteOptions): Promise<void>;

  /** Throws `unsupported` when `supportsPush` is false. */
  watch(credentials: ProviderCredentials, calendarId: string, request: WatchRequest): Promise<WatchChannel>;
  stopWatch(credentials: ProviderCredentials, channel: Pick<WatchChannel, "channelId" | "resourceId">): Promise<void>;
  /**
   * Google: opens a new channel, then stops the old one (channels cannot be extended).
   * Microsoft: extends the same subscription. Either way the result replaces the stored channel.
   */
  renewWatch(
    credentials: ProviderCredentials,
    calendarId: string,
    channel: WatchChannel,
    request: WatchRequest,
  ): Promise<WatchChannel>;

  /** Turns anything an adapter method threw into revoked / transient / rate_limited. */
  handleAuthFailure(error: unknown): FailureClass;
}

/** Providers that sign in with OAuth (Google, Microsoft). */
export interface OAuthCalendarProvider extends CalendarProvider {
  buildAuthUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<OAuthExchangeResult>;
}

export function isOAuthProvider(provider: CalendarProvider): provider is OAuthCalendarProvider {
  return "buildAuthUrl" in provider && "exchangeCode" in provider;
}

/** Constant-time check of the shared webhook secret the provider echoes back. */
export function webhookTokenMatches(received: string | null | undefined, expected: string): boolean {
  if (!received || !expected) return false;
  const a = createHash("sha256").update(received).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Stable id-safe string from an idempotency key (hex is valid for Google event ids). */
export function idFromKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Narrows a credentials value for an adapter and fails loudly on a mismatch. */
export function requireOAuth(credentials: ProviderCredentials, provider: "google" | "microsoft"): OAuthCredentials {
  if (credentials.kind !== "oauth" || credentials.provider !== provider) {
    throw new TypeError(`Expected ${provider} OAuth credentials`);
  }
  return credentials;
}
