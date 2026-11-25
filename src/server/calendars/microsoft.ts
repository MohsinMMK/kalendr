/**
 * Microsoft 365 / Outlook adapter on Microsoft Graph, over plain `fetch`.
 *
 * Why not the Graph SDK client: its value is middleware (retry, redirects) and a
 * fluent builder, and we want neither. Every response here is parsed with zod, every
 * call goes through one injectable transport, and the token refresh is ours to
 * report to the caller. The Microsoft Graph SDK is not used.
 *
 * Scopes:
 *  - Calendars.ReadWrite: read busy time and write appointments in the person's own
 *    calendars. The `.Read` variant cannot write. We do not ask for `.Shared`, so a
 *    colleague's shared calendar is not readable (add it only if a customer needs it).
 *  - offline_access: a refresh token, so sync works without the person present.
 *  - User.Read: the sign-in address for "Connected as ...".
 * Tenant is `common`: work, school and personal Microsoft accounts all work.
 */
import { z } from "zod";

import type { OAuthAppConfig } from "./config";
import { CalendarProviderError, classifyFailure, errorFromStatus, parseRetryAfter } from "./errors";
import { createFetchTransport, parseBody, type HttpRequest, type HttpResponse, type HttpTransport } from "./http";
import {
  idFromKey,
  requireOAuth,
  type BusyEvent,
  type CalendarInfo,
  type EventInput,
  type EventWriteResult,
  type OAuthCalendarProvider,
  type OAuthCredentials,
  type OAuthExchangeResult,
  type ProviderCredentials,
  type RefreshedTokens,
  type SyncResult,
  type WatchChannel,
  type WatchRequest,
  type WriteOptions,
} from "./provider";
import { isValidTimeZone, zonedWallTimeToIso } from "./time";
import { accessTokenIsFresh, TokenMemory } from "./tokens";

export const MICROSOFT_SCOPES = ["offline_access", "Calendars.ReadWrite", "User.Read"] as const;
const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH = "https://graph.microsoft.com/v1.0";
const MAX_PAGES = 40;
/** Graph allows at most 4230 minutes for event subscriptions; stay a little under. */
const SUBSCRIPTION_MINUTES = 4200;
const EVENT_FIELDS = "id,start,end,isAllDay,isCancelled,showAs,responseStatus";

const dateTimeSchema = z.object({ dateTime: z.string(), timeZone: z.string().optional() });
const deltaEventSchema = z.object({
  id: z.string(),
  start: dateTimeSchema.optional(),
  end: dateTimeSchema.optional(),
  isAllDay: z.boolean().optional(),
  isCancelled: z.boolean().optional(),
  showAs: z.string().optional(),
  responseStatus: z.object({ response: z.string().optional() }).optional(),
  "@removed": z.object({ reason: z.string().optional() }).optional(),
});
const deltaPageSchema = z.object({
  value: z.array(deltaEventSchema).default([]),
  "@odata.nextLink": z.string().optional(),
  "@odata.deltaLink": z.string().optional(),
});
const calendarsPageSchema = z.object({
  value: z.array(z.object({ id: z.string(), name: z.string().optional(), isDefaultCalendar: z.boolean().optional(), canEdit: z.boolean().optional() })).default([]),
  "@odata.nextLink": z.string().optional(),
});
const writtenEventSchema = z.object({ id: z.string(), "@odata.etag": z.string().optional(), changeKey: z.string().optional() });
const subscriptionSchema = z.object({ id: z.string(), expirationDateTime: z.string() });
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number(),
  scope: z.string().default(""),
});
const tokenErrorSchema = z.object({ error: z.string().optional(), error_description: z.string().optional() });
const graphErrorSchema = z.object({ error: z.object({ code: z.string().optional() }).optional() });

export interface MicrosoftDeps {
  app: OAuthAppConfig;
  transport?: HttpTransport;
  onCredentialsRefreshed?: (tokens: RefreshedTokens) => void | Promise<void>;
  now?: () => Date;
}

export function createMicrosoftProvider(deps: MicrosoftDeps): OAuthCalendarProvider {
  const transport = deps.transport ?? createFetchTransport();
  const now = deps.now ?? (() => new Date());
  const memory = new TokenMemory();

  async function tokenRequest(form: Record<string, string>, context: string): Promise<z.infer<typeof tokenSchema>> {
    const response = await transport({
      method: "POST",
      url: `${AUTHORITY}/token`,
      form: { client_id: deps.app.clientId, client_secret: deps.app.clientSecret, ...form },
    });
    if (response.status === 200) return parseBody(tokenSchema, response.body, context);
    const error = tokenErrorSchema.safeParse(response.body);
    const code = error.success ? (error.data.error ?? "") : "";
    // invalid_grant and interaction_required mean the person must sign in again (the AADSTS number in the description
    // says why). invalid_client and unauthorized_client mean this server's app id or secret is wrong: every connection
    // would fail the same way, so no one's connection is marked revoked for it.
    if (response.status === 400 || response.status === 401) {
      if (/invalid_grant|interaction_required/i.test(code)) {
        throw new CalendarProviderError("revoked", `${context}: the Microsoft grant is no longer valid`, { status: response.status });
      }
      throw new CalendarProviderError("invalid", `${context}: token request rejected`, { status: response.status });
    }
    throw errorFromStatus(response.status, context, parseRetryAfter(response.headers["retry-after"], now()));
  }

  async function refresh(oauth: OAuthCredentials): Promise<OAuthCredentials> {
    const token = await tokenRequest(
      { grant_type: "refresh_token", refresh_token: oauth.refreshToken, scope: MICROSOFT_SCOPES.join(" ") },
      "microsoft.refresh",
    );
    const tokens: RefreshedTokens = {
      // Microsoft rotates refresh tokens: the new one replaces the old.
      refreshToken: token.refresh_token ?? oauth.refreshToken,
      accessToken: token.access_token,
      expiresAt: new Date(now().getTime() + token.expires_in * 1000).toISOString(),
    };
    memory.remember(oauth.refreshToken, tokens);
    await deps.onCredentialsRefreshed?.(tokens);
    return { ...oauth, ...tokens };
  }

  /** Calls Graph with a fresh token; one forced refresh and retry on 401 before giving up as revoked. */
  async function graph(credentials: ProviderCredentials, request: HttpRequest): Promise<HttpResponse> {
    assertGraphUrl(request.url);
    let oauth = memory.overlay(requireOAuth(credentials, "microsoft"));
    if (!accessTokenIsFresh(oauth, now())) oauth = await refresh(oauth);
    const send = (token: string) =>
      transport({ ...request, headers: { ...request.headers, authorization: `Bearer ${token}` } });
    let response = await send(oauth.accessToken ?? "");
    if (response.status === 401) {
      oauth = await refresh(oauth);
      response = await send(oauth.accessToken ?? "");
      if (response.status === 401) throw new CalendarProviderError("revoked", "microsoft.graph: unauthorised after refresh", { status: 401 });
    }
    return response;
  }

  async function pages<T extends { "@odata.nextLink"?: string | undefined }>(
    credentials: ProviderCredentials,
    firstUrl: string,
    headers: Record<string, string> | undefined,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    context: string,
    onPage: (page: T) => void,
  ): Promise<void> {
    let url: string | undefined = firstUrl;
    for (let page = 0; url && page < MAX_PAGES; page += 1) {
      const response: HttpResponse = await graph(credentials, { method: "GET", url, headers });
      if (response.status !== 200) throw graphStatusError(response, context, now());
      const data = parseBody(schema, response.body, context);
      onPage(data);
      url = data["@odata.nextLink"];
    }
    if (url) throw new CalendarProviderError("transient", `${context}: too many pages`);
  }

  return {
    id: "microsoft",
    supportsPush: true,

    buildAuthUrl(state, redirectUri) {
      const url = new URL(`${AUTHORITY}/authorize`);
      url.search = new URLSearchParams({
        client_id: deps.app.clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        response_mode: "query",
        scope: MICROSOFT_SCOPES.join(" "),
        state,
        prompt: "select_account",
      }).toString();
      return url.toString();
    },

    async exchangeCode(code, redirectUri): Promise<OAuthExchangeResult> {
      const token = await tokenRequest(
        { grant_type: "authorization_code", code, redirect_uri: redirectUri, scope: MICROSOFT_SCOPES.join(" ") },
        "microsoft.exchangeCode",
      ).catch((error: unknown) => {
        if (error instanceof CalendarProviderError && error.kind === "revoked") {
          throw new CalendarProviderError("invalid", "microsoft.exchangeCode: the code was rejected", { cause: error });
        }
        throw error;
      });
      const grantedScopes = token.scope.split(" ").filter(Boolean);
      if (!grantedScopes.some((scope) => scope.toLowerCase().endsWith("calendars.readwrite"))) {
        throw new CalendarProviderError("invalid", "microsoft.exchangeCode: calendar permission was not granted");
      }
      if (!token.refresh_token) {
        throw new CalendarProviderError("invalid", "microsoft.exchangeCode: no refresh token returned");
      }
      const expiresAt = new Date(now().getTime() + token.expires_in * 1000).toISOString();
      const result: OAuthExchangeResult = {
        refreshToken: token.refresh_token,
        accessToken: token.access_token,
        expiresAt,
        accountEmail: null,
        grantedScopes,
      };
      const account = await verifyAccount({ kind: "oauth", provider: "microsoft", ...result });
      return { ...result, accountEmail: account.accountEmail };
    },

    verifyAccount,

    async listCalendars(credentials) {
      const calendars: CalendarInfo[] = [];
      await pages(credentials, `${GRAPH}/me/calendars?$select=id,name,isDefaultCalendar,canEdit&$top=100`, undefined, calendarsPageSchema, "microsoft.listCalendars", (page) => {
        for (const item of page.value) {
          calendars.push({ id: item.id, name: item.name ?? item.id, primary: item.isDefaultCalendar === true, canWrite: item.canEdit !== false, timezone: null });
        }
      });
      return calendars;
    },

    async syncChanges(credentials, calendarId, request): Promise<SyncResult> {
      const incremental = Boolean(request.syncToken);
      const first = request.syncToken
        ? request.syncToken
        : `${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta?${new URLSearchParams({
            startDateTime: request.from.toISOString(),
            endDateTime: request.to.toISOString(),
            // Subject, body, attendees and location are never requested.
            $select: EVENT_FIELDS,
          }).toString()}`;
      const events: BusyEvent[] = [];
      let nextSyncToken: string | null = null;
      try {
        await pages(
          credentials,
          first,
          { prefer: 'outlook.timezone="UTC", odata.maxpagesize=100' },
          deltaPageSchema,
          "microsoft.syncChanges",
          (page) => {
            for (const item of page.value) {
              const busy = toBusyEvent(item);
              if (busy) events.push(busy);
            }
            if (page["@odata.deltaLink"]) nextSyncToken = page["@odata.deltaLink"];
          },
        );
      } catch (error) {
        if (incremental && error instanceof CalendarProviderError && error.kind === "not_found" && error.status === 410) {
          return { fullResyncRequired: true };
        }
        throw error;
      }
      return { fullResyncRequired: false, mode: incremental ? "delta" : "snapshot", events, nextSyncToken, unsupportedRecurrences: 0 };
    },

    async createEvent(credentials, calendarId, input) {
      const response = await graph(credentials, {
        method: "POST",
        url: `${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}/events`,
        json: { ...eventBody(input), ...(input.idempotencyKey ? { transactionId: idFromKey(input.idempotencyKey).slice(0, 64) } : {}) },
      });
      if (response.status !== 201 && response.status !== 200) throw graphStatusError(response, "microsoft.createEvent", now());
      return toWriteResult(response.body, "microsoft.createEvent");
    },

    async updateEvent(credentials, calendarId, eventId, input, options: WriteOptions = {}) {
      const response = await graph(credentials, {
        method: "PATCH",
        url: `${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        headers: options.etag ? { "if-match": options.etag } : undefined,
        json: eventBody(input),
      });
      if (response.status !== 200) throw graphStatusError(response, "microsoft.updateEvent", now());
      return toWriteResult(response.body, "microsoft.updateEvent");
    },

    async deleteEvent(credentials, calendarId, eventId, options: WriteOptions = {}) {
      const response = await graph(credentials, {
        method: "DELETE",
        url: `${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        headers: options.etag ? { "if-match": options.etag } : undefined,
      });
      if (response.status === 204 || response.status === 200 || response.status === 404 || response.status === 410) return;
      throw graphStatusError(response, "microsoft.deleteEvent", now());
    },

    async watch(credentials, calendarId, request) {
      return createSubscription(credentials, calendarId, request);
    },

    async stopWatch(credentials, channel) {
      const response = await graph(credentials, { method: "DELETE", url: `${GRAPH}/subscriptions/${encodeURIComponent(channel.channelId)}` });
      if (response.status === 204 || response.status === 200 || response.status === 404) return;
      throw graphStatusError(response, "microsoft.stopWatch", now());
    },

    async renewWatch(credentials, calendarId, channel, request) {
      const response = await graph(credentials, {
        method: "PATCH",
        url: `${GRAPH}/subscriptions/${encodeURIComponent(channel.channelId)}`,
        json: { expirationDateTime: expiryFromNow() },
      });
      // A subscription Microsoft already dropped cannot be renewed; make a new one.
      if (response.status === 404) return createSubscription(credentials, calendarId, request);
      if (response.status !== 200) throw graphStatusError(response, "microsoft.renewWatch", now());
      return toChannel(parseBody(subscriptionSchema, response.body, "microsoft.renewWatch"));
    },

    handleAuthFailure: classifyFailure,
  };

  async function verifyAccount(credentials: ProviderCredentials): Promise<{ accountEmail: string | null }> {
    const response = await graph(credentials, { method: "GET", url: `${GRAPH}/me?$select=mail,userPrincipalName` });
    if (response.status !== 200) throw graphStatusError(response, "microsoft.verifyAccount", now());
    const body = parseBody(z.object({ mail: z.string().nullish(), userPrincipalName: z.string().nullish() }), response.body, "microsoft.verifyAccount");
    return { accountEmail: body.mail ?? body.userPrincipalName ?? null };
  }

  function expiryFromNow(): string {
    return new Date(now().getTime() + SUBSCRIPTION_MINUTES * 60_000).toISOString();
  }

  async function createSubscription(credentials: ProviderCredentials, calendarId: string, request: WatchRequest): Promise<WatchChannel> {
    if (!request.callbackUrl.startsWith("https://")) {
      throw new CalendarProviderError("invalid", "microsoft.watch: the callback must be an https address");
    }
    const response = await graph(credentials, {
      method: "POST",
      url: `${GRAPH}/subscriptions`,
      json: {
        changeType: "created,updated,deleted",
        notificationUrl: request.callbackUrl,
        resource: `/me/calendars/${calendarId}/events`,
        expirationDateTime: expiryFromNow(),
        // Echoed in every notification; the webhook route compares it in constant time.
        clientState: request.token,
      },
    });
    if (response.status !== 201 && response.status !== 200) throw graphStatusError(response, "microsoft.watch", now());
    return toChannel(parseBody(subscriptionSchema, response.body, "microsoft.watch"));
  }
}

function toChannel(subscription: z.infer<typeof subscriptionSchema>): WatchChannel {
  return { channelId: subscription.id, resourceId: null, expiresAt: new Date(subscription.expirationDateTime).toISOString() };
}

/** The deltaLink and nextLink arrive from the network; never send our bearer token anywhere but Graph. */
function assertGraphUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CalendarProviderError("invalid", "microsoft.graph: not a valid address");
  }
  if (url.protocol !== "https:" || url.hostname !== "graph.microsoft.com") {
    throw new CalendarProviderError("invalid", "microsoft.graph: refusing to call a non-Graph address");
  }
}

function toGraphDateTime(iso: string): { dateTime: string; timeZone: string } {
  return { dateTime: `${new Date(iso).toISOString().slice(0, 19)}.0000000`, timeZone: "UTC" };
}

function eventBody(input: EventInput): Record<string, unknown> {
  return {
    subject: input.title,
    body: input.description ? { contentType: "text", content: input.description } : undefined,
    location: input.location ? { displayName: input.location } : undefined,
    // UTC keeps the instant exact; Outlook shows it in the person's own zone.
    start: toGraphDateTime(input.start),
    end: toGraphDateTime(input.end),
    showAs: "busy",
  };
}

function toWriteResult(body: unknown, context: string): EventWriteResult {
  const parsed = parseBody(writtenEventSchema, body, context);
  return { eventId: parsed.id, etag: parsed["@odata.etag"] ?? parsed.changeKey ?? null };
}

function graphDateTimeToIso(value: { dateTime: string; timeZone?: string | undefined }): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value.dateTime);
  if (!match) return null;
  const zone = value.timeZone && isValidTimeZone(value.timeZone) ? value.timeZone : "UTC";
  return zonedWallTimeToIso(
    { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6]) },
    zone,
  );
}

function toBusyEvent(item: z.infer<typeof deltaEventSchema>): BusyEvent | null {
  if (item["@removed"]) {
    return { sourceEventId: item.id, startsAt: null, endsAt: null, cancelled: true };
  }
  const startsAt = item.start ? graphDateTimeToIso(item.start) : null;
  const endsAt = item.end ? graphDateTimeToIso(item.end) : null;
  const cancelled = item.isCancelled === true;
  if (!cancelled && (!startsAt || !endsAt)) return null;
  const declined = item.responseStatus?.response === "declined";
  return {
    sourceEventId: item.id,
    startsAt,
    endsAt,
    cancelled,
    // "Working elsewhere" is how Outlook marks time that is not a conflict.
    transparent: item.showAs === "free" || item.showAs === "workingElsewhere" || declined,
    allDay: item.isAllDay === true,
  };
}

function graphStatusError(response: HttpResponse, context: string, now: Date): CalendarProviderError {
  const retryAfter = parseRetryAfter(response.headers["retry-after"], now);
  const code = graphErrorSchema.safeParse(response.body);
  const errorCode = code.success ? (code.data.error?.code ?? "") : "";
  if (response.status === 410 || errorCode === "syncStateNotFound" || errorCode === "resyncRequired") {
    return new CalendarProviderError("not_found", `${context}: sync state is gone`, { status: 410 });
  }
  if (response.status === 403 && /accessdenied|authorization/i.test(errorCode)) {
    return new CalendarProviderError("revoked", `${context}: permission missing`, { status: 403 });
  }
  // Graph throttles with 429, and sometimes 503 plus Retry-After.
  if ((response.status === 503 || response.status === 504) && retryAfter !== null) {
    return new CalendarProviderError("rate_limited", `${context}: throttled`, { status: response.status, retryAfterSeconds: retryAfter });
  }
  return errorFromStatus(response.status, context, retryAfter);
}
