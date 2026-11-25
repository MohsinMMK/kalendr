/**
 * Google Calendar adapter.
 *
 * Scopes (the narrowest set that does the job):
 *  - calendar.events: read busy time and write appointments. The read-only variant
 *    cannot write, and the full `calendar` scope also edits sharing and calendars.
 *  - calendar.calendarlist.readonly: list the calendars so the person can tick which
 *    ones block availability. Without it `calendarList.list` is refused.
 *  - openid + email: show "Connected as ..." and nothing else.
 * We never request `calendar` or `calendar.readonly`.
 *
 * Busy time uses `events.list` with `fields=` set to ids, times and flags only, so
 * titles and attendee addresses are never even transferred.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { OAuthAppConfig } from "./config";
import { CalendarProviderError, classifyFailure } from "./errors";
import { parseBody, type HttpRequest, type HttpResponse } from "./http";
import {
  idFromKey,
  requireOAuth,
  type BusyEvent,
  type CalendarInfo,
  type EventWriteResult,
  type OAuthCalendarProvider,
  type OAuthExchangeResult,
  type ProviderCredentials,
  type RefreshedTokens,
  type SyncRequest,
  type SyncResult,
  type WatchChannel,
  type WatchRequest,
  type WriteOptions,
} from "./provider";
import { isValidTimeZone } from "./time";
import { TokenMemory } from "./tokens";
import { createGoogleTransport, type GoogleTransport } from "./google-transport";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
] as const;
const REQUIRED_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const API = "https://www.googleapis.com/calendar/v3";
const MAX_PAGES = 40;
/** Seven days is what Google grants calendar channels in practice; renewal runs well before. */
const WATCH_TTL_SECONDS = 604_800;

import {
  calendarListSchema,
  emailFromIdToken,
  eventBody,
  eventsPageSchema,
  googleStatusError,
  mapThrown,
  toBusyEvent,
  toWriteResult,
  tokenResponseSchema,
  watchSchema,
  withQuery,
} from "./google-parse";

export interface GoogleDeps {
  app: OAuthAppConfig;
  transport?: GoogleTransport;
  onCredentialsRefreshed?: (tokens: RefreshedTokens) => void | Promise<void>;
  now?: () => Date;
}

export function createGoogleProvider(deps: GoogleDeps): OAuthCalendarProvider {
  const transport = deps.transport ?? createGoogleTransport(deps.app);
  const now = deps.now ?? (() => new Date());
  const memory = new TokenMemory();

  async function call(credentials: ProviderCredentials, request: HttpRequest, context: string): Promise<HttpResponse> {
    const oauth = requireOAuth(credentials, "google");
    const original = oauth.refreshToken;
    const pending: Promise<void>[] = [];
    try {
      const response = await transport.request(
        memory.overlay(oauth),
        (tokens) => {
          memory.remember(original, tokens);
          if (deps.onCredentialsRefreshed) pending.push(Promise.resolve(deps.onCredentialsRefreshed(tokens)));
        },
        request,
      );
      await Promise.all(pending);
      return response;
    } catch (error) {
      throw mapThrown(error, context);
    }
  }

  async function paged<T extends { nextPageToken?: string | undefined }>(
    credentials: ProviderCredentials,
    build: (pageToken: string | undefined) => HttpRequest,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    context: string,
    onPage: (page: T) => void,
  ): Promise<void> {
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await call(credentials, build(pageToken), context);
      if (response.status !== 200) throw googleStatusError(response, context, now());
      const data = parseBody(schema, response.body, context);
      onPage(data);
      if (!data.nextPageToken) return;
      pageToken = data.nextPageToken;
    }
    throw new CalendarProviderError("transient", `${context}: too many pages`);
  }

  return {
    id: "google",
    supportsPush: true,

    buildAuthUrl(state, redirectUri) {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: deps.app.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: GOOGLE_SCOPES.join(" "),
        state,
        // Offline access plus a consent screen is the only way Google reliably returns a refresh token.
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "false",
      }).toString();
      return url.toString();
    },

    async exchangeCode(code, redirectUri): Promise<OAuthExchangeResult> {
      let raw: unknown;
      try {
        raw = await transport.exchangeCode({ code, redirectUri });
      } catch (error) {
        const mapped = mapThrown(error, "google.exchangeCode", "invalid");
        // A bad or reused code is the caller's problem, not a revoked connection.
        if (mapped.kind === "revoked") throw new CalendarProviderError("invalid", "google.exchangeCode: the code was rejected", { cause: error });
        throw mapped;
      }
      const tokens = parseBody(tokenResponseSchema, raw, "google.exchangeCode");
      const grantedScopes = tokens.scope.split(" ").filter(Boolean);
      // People can untick calendar access on the consent screen; without it nothing works.
      if (!grantedScopes.includes(REQUIRED_SCOPE)) {
        throw new CalendarProviderError("invalid", "google.exchangeCode: calendar permission was not granted");
      }
      if (!tokens.refresh_token) {
        throw new CalendarProviderError("invalid", "google.exchangeCode: no refresh token returned");
      }
      return {
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token,
        expiresAt: new Date(tokens.expiry_date ?? now().getTime() + 3_000_000).toISOString(),
        accountEmail: emailFromIdToken(tokens.id_token),
        grantedScopes,
      };
    },

    async verifyAccount(credentials) {
      const response = await call(
        credentials,
        { method: "GET", url: `${API}/users/me/calendarList/primary?fields=id` },
        "google.verifyAccount",
      );
      if (response.status !== 200) throw googleStatusError(response, "google.verifyAccount", now());
      const body = parseBody(z.object({ id: z.string() }), response.body, "google.verifyAccount");
      return { accountEmail: body.id.includes("@") ? body.id : null };
    },

    async listCalendars(credentials) {
      const calendars: CalendarInfo[] = [];
      await paged(
        credentials,
        (pageToken) => ({
          method: "GET",
          url: withQuery(`${API}/users/me/calendarList`, {
            minAccessRole: "reader",
            maxResults: "250",
            fields: "nextPageToken,items(id,summary,summaryOverride,primary,accessRole,timeZone)",
            pageToken,
          }),
        }),
        calendarListSchema,
        "google.listCalendars",
        (page) => {
          for (const item of page.items) {
            calendars.push({
              id: item.id,
              name: item.summaryOverride ?? item.summary ?? item.id,
              primary: item.primary === true,
              canWrite: item.accessRole === "owner" || item.accessRole === "writer",
              timezone: item.timeZone && isValidTimeZone(item.timeZone) ? item.timeZone : null,
            });
          }
        },
      );
      return calendars;
    },

    async syncChanges(credentials, calendarId, request: SyncRequest): Promise<SyncResult> {
      const incremental = Boolean(request.syncToken);
      const events: BusyEvent[] = [];
      let nextSyncToken: string | null = null;
      try {
        await paged(
          credentials,
          (pageToken) => ({
            method: "GET",
            url: withQuery(`${API}/calendars/${encodeURIComponent(calendarId)}/events`, {
              // Titles, descriptions and attendee addresses are not requested at all.
              fields: "nextPageToken,nextSyncToken,timeZone,items(id,status,start,end,transparency,eventType,attendees(self,responseStatus))",
              singleEvents: "true",
              maxResults: "250",
              pageToken,
              // Google forbids timeMin/timeMax together with a sync token: the token carries the window.
              ...(incremental
                ? { syncToken: request.syncToken ?? undefined }
                : { timeMin: request.from.toISOString(), timeMax: request.to.toISOString() }),
            }),
          }),
          eventsPageSchema,
          "google.syncChanges",
          (page) => {
            for (const item of page.items) {
              const busy = toBusyEvent(item, page.timeZone ?? "UTC");
              if (busy) events.push(busy);
            }
            if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
          },
        );
      } catch (error) {
        // 410 GONE: the sync token expired. The cache for this calendar must be rebuilt.
        if (incremental && error instanceof CalendarProviderError && error.status === 410) {
          return { fullResyncRequired: true };
        }
        throw error;
      }
      return {
        fullResyncRequired: false,
        mode: incremental ? "delta" : "snapshot",
        events,
        nextSyncToken,
        unsupportedRecurrences: 0,
      };
    },

    async createEvent(credentials, calendarId, input) {
      const body = eventBody(input);
      const id = input.idempotencyKey ? idFromKey(input.idempotencyKey) : undefined;
      const response = await call(
        credentials,
        {
          method: "POST",
          url: withQuery(`${API}/calendars/${encodeURIComponent(calendarId)}/events`, { sendUpdates: "none", fields: "id,etag" }),
          json: id ? { ...body, id } : body,
        },
        "google.createEvent",
      );
      if (response.status === 409 && id) {
        // The same key was already used: the first attempt landed. Return that event.
        return fetchExisting(credentials, calendarId, id);
      }
      if (response.status !== 200) throw googleStatusError(response, "google.createEvent", now());
      return toWriteResult(response.body, "google.createEvent");
    },

    async updateEvent(credentials, calendarId, eventId, input, options: WriteOptions = {}) {
      const response = await call(
        credentials,
        {
          method: "PATCH",
          url: withQuery(`${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
            sendUpdates: "none",
            fields: "id,etag",
          }),
          headers: options.etag ? { "if-match": options.etag } : undefined,
          json: eventBody(input),
        },
        "google.updateEvent",
      );
      if (response.status !== 200) throw googleStatusError(response, "google.updateEvent", now());
      return toWriteResult(response.body, "google.updateEvent");
    },

    async deleteEvent(credentials, calendarId, eventId, options: WriteOptions = {}) {
      const response = await call(
        credentials,
        {
          method: "DELETE",
          url: withQuery(`${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { sendUpdates: "none" }),
          headers: options.etag ? { "if-match": options.etag } : undefined,
        },
        "google.deleteEvent",
      );
      // 404 and 410 both mean it is already gone, which is what the caller wanted.
      if (response.status === 204 || response.status === 200 || response.status === 404 || response.status === 410) return;
      throw googleStatusError(response, "google.deleteEvent", now());
    },

    async watch(credentials, calendarId, request) {
      return openChannel(credentials, calendarId, request);
    },

    stopWatch,

    async renewWatch(credentials, calendarId, channel, request) {
      // Channels cannot be extended: open the new one first so there is never a gap, then retire the old.
      const fresh = await openChannel(credentials, calendarId, request);
      try {
        await stopWatch(credentials, channel);
      } catch {
        // The old channel expires by itself; a failed stop must not lose the new one.
      }
      return fresh;
    },

    handleAuthFailure: classifyFailure,
  };

  async function stopWatch(credentials: ProviderCredentials, channel: Pick<WatchChannel, "channelId" | "resourceId">): Promise<void> {
    const response = await call(
      credentials,
      { method: "POST", url: `${API}/channels/stop`, json: { id: channel.channelId, resourceId: channel.resourceId ?? undefined } },
      "google.stopWatch",
    );
    if (response.status === 204 || response.status === 200 || response.status === 404) return;
    throw googleStatusError(response, "google.stopWatch", now());
  }

  async function openChannel(credentials: ProviderCredentials, calendarId: string, request: WatchRequest): Promise<WatchChannel> {
    if (!request.callbackUrl.startsWith("https://")) {
      throw new CalendarProviderError("invalid", "google.watch: the callback must be an https address");
    }
    const response = await call(
      credentials,
      {
        method: "POST",
        url: `${API}/calendars/${encodeURIComponent(calendarId)}/events/watch`,
        json: {
          id: randomUUID(),
          type: "web_hook",
          address: request.callbackUrl,
          token: request.token,
          params: { ttl: String(WATCH_TTL_SECONDS) },
        },
      },
      "google.watch",
    );
    if (response.status !== 200) throw googleStatusError(response, "google.watch", now());
    const body = parseBody(watchSchema, response.body, "google.watch");
    const expiresMs = body.expiration === undefined ? now().getTime() + WATCH_TTL_SECONDS * 1000 : Number(body.expiration);
    return {
      channelId: body.id,
      resourceId: body.resourceId ?? null,
      expiresAt: new Date(Number.isFinite(expiresMs) ? expiresMs : now().getTime() + WATCH_TTL_SECONDS * 1000).toISOString(),
    };
  }

  async function fetchExisting(credentials: ProviderCredentials, calendarId: string, eventId: string): Promise<EventWriteResult> {
    const response = await call(
      credentials,
      { method: "GET", url: withQuery(`${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { fields: "id,etag" }) },
      "google.createEvent",
    );
    if (response.status !== 200) throw googleStatusError(response, "google.createEvent", now());
    return toWriteResult(response.body, "google.createEvent");
  }
}
