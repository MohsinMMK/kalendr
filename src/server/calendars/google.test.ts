import { describe, expect, it, vi } from "vitest";

import calendarList from "./__fixtures__/google-calendar-list.json";
import eventsDelta from "./__fixtures__/google-events-delta.json";
import eventsPage1 from "./__fixtures__/google-events-initial-page1.json";
import eventsPage2 from "./__fixtures__/google-events-initial-page2.json";
import eventWritten from "./__fixtures__/google-event-written.json";
import gone from "./__fixtures__/google-gone.json";
import rateLimit from "./__fixtures__/google-rate-limit.json";
import tokenResponse from "./__fixtures__/google-token-response.json";
import watchResponse from "./__fixtures__/google-watch.json";
import { GOOGLE_SCOPES, createGoogleProvider } from "./google";
import type { GoogleTransport } from "./google-transport";
import type { HttpRequest, HttpResponse } from "./http";
import { webhookTokenMatches, type OAuthCredentials, type RefreshedTokens } from "./provider";
import { allKeys, FORBIDDEN_FIELDS, json, NOW, WINDOW } from "./test-support";

const credentials: OAuthCredentials = { kind: "oauth", provider: "google", refreshToken: "refresh-1", accessToken: "access-1", expiresAt: "2026-11-19T11:00:00.000Z" };
const app = { clientId: "client-id", clientSecret: "client-secret" };

type Handler = (credentials: OAuthCredentials, onTokens: (tokens: RefreshedTokens) => void, request: HttpRequest) => HttpResponse | Promise<HttpResponse>;

function setup(handler: Handler, onCredentialsRefreshed?: (tokens: RefreshedTokens) => void) {
  const requests: HttpRequest[] = [];
  const seen: OAuthCredentials[] = [];
  const exchange = vi.fn<GoogleTransport["exchangeCode"]>(async () => tokenResponse);
  const transport: GoogleTransport = {
    exchangeCode: exchange,
    request: async (creds, onTokens, request) => {
      requests.push(request);
      seen.push(creds);
      return handler(creds, onTokens, request);
    },
  };
  return { provider: createGoogleProvider({ app, transport, onCredentialsRefreshed, now: () => NOW }), requests, seen, exchange };
}

const query = (request: HttpRequest) => new URL(request.url).searchParams;

describe("google adapter: sign-in", () => {
  it("asks for the narrowest scopes and offline access, and carries the state", () => {
    const { provider } = setup(() => json(200, {}));
    if (!("buildAuthUrl" in provider)) throw new Error("expected an OAuth provider");
    const url = new URL(provider.buildAuthUrl("state-123", "https://app.example.test/callback"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    const scopes = url.searchParams.get("scope")?.split(" ") ?? [];
    expect(scopes).toEqual([...GOOGLE_SCOPES]);
    expect(scopes).not.toContain("https://www.googleapis.com/auth/calendar");
    expect(scopes).not.toContain("https://www.googleapis.com/auth/calendar.readonly");
  });

  it("exchanges the code, reads the address from the id token and reports granted scopes", async () => {
    const { provider } = setup(() => json(200, {}));
    if (!("exchangeCode" in provider)) throw new Error("expected an OAuth provider");
    const result = await provider.exchangeCode("code-1", "https://app.example.test/callback");
    expect(result).toMatchObject({ refreshToken: "1//refresh", accessToken: "ya29.access", accountEmail: "asha.rao@gmail.example" });
    expect(result.expiresAt).toBe(new Date(1795400000000).toISOString());
    expect(result.grantedScopes).toContain("https://www.googleapis.com/auth/calendar.events");
  });

  it("rejects a consent where calendar access was unticked, and a missing refresh token", async () => {
    const { provider, exchange } = setup(() => json(200, {}));
    if (!("exchangeCode" in provider)) throw new Error("expected an OAuth provider");
    exchange.mockResolvedValueOnce({ ...tokenResponse, scope: "openid email" });
    await expect(provider.exchangeCode("c", "r")).rejects.toMatchObject({ kind: "invalid" });
    exchange.mockResolvedValueOnce({ ...tokenResponse, refresh_token: undefined });
    await expect(provider.exchangeCode("c", "r")).rejects.toMatchObject({ kind: "invalid" });
  });

  it("treats a rejected code as invalid, not as a revoked connection", async () => {
    const { provider, exchange } = setup(() => json(200, {}));
    if (!("exchangeCode" in provider)) throw new Error("expected an OAuth provider");
    exchange.mockRejectedValueOnce(Object.assign(new Error("invalid_grant"), { response: { status: 400, data: { error: "invalid_grant" } } }));
    await expect(provider.exchangeCode("c", "r")).rejects.toMatchObject({ kind: "invalid" });
  });
});

describe("google adapter: reading", () => {
  it("lists calendars with write access and display names", async () => {
    const { provider, requests } = setup(() => json(200, calendarList));
    const calendars = await provider.listCalendars(credentials);
    expect(calendars).toEqual([
      { id: "asha.rao@gmail.example", name: "asha.rao@gmail.example", primary: true, canWrite: true, timezone: "Asia/Kolkata" },
      { id: "family123@group.calendar.google.example", name: "Family plans", primary: false, canWrite: true, timezone: "Asia/Kolkata" },
      { id: "holidays@group.v.calendar.google.example", name: "Holidays in India", primary: false, canWrite: false, timezone: "UTC" },
    ]);
    expect(query(requests[0] as HttpRequest).get("fields")).not.toContain("description");
  });

  it("initial sync pages through the window and converts every shape of event", async () => {
    const { provider, requests } = setup((_c, _t, request) => json(200, query(request).get("pageToken") ? eventsPage2 : eventsPage1));
    const result = await provider.syncChanges(credentials, "asha.rao@gmail.example", WINDOW);
    if (result.fullResyncRequired) throw new Error("unexpected resync");
    expect(result.mode).toBe("snapshot");
    expect(result.nextSyncToken).toBe("sync-token-A");

    // The window goes to Google and the sync token does not.
    const first = query(requests[0] as HttpRequest);
    expect(first.get("timeMin")).toBe(WINDOW.from.toISOString());
    expect(first.get("timeMax")).toBe(WINDOW.to.toISOString());
    expect(first.get("singleEvents")).toBe("true");
    expect(first.has("syncToken")).toBe(false);
    // Only ids, times and flags are even requested.
    expect(first.get("fields")).not.toMatch(/summary|description|location|email/);
    expect(requests[1] && query(requests[1]).get("pageToken")).toBe("page-2-token");

    const byId = Object.fromEntries(result.events.map((event) => [event.sourceEventId, event]));
    expect(byId.evt1).toMatchObject({ startsAt: "2026-11-20T04:30:00.000Z", endsAt: "2026-11-20T05:30:00.000Z", cancelled: false, transparent: false, allDay: false });
    // All-day event: Kolkata midnight, end date exclusive.
    expect(byId.evt2).toMatchObject({ startsAt: "2026-11-20T18:30:00.000Z", endsAt: "2026-11-22T18:30:00.000Z", allDay: true, transparent: false });
    // "Free" events must not block slots.
    expect(byId.evt3?.transparent).toBe(true);
    // An invitation the person declined does not block either.
    expect(byId.evt4?.transparent).toBe(true);
    // Recurring instances arrive already expanded (singleEvents=true).
    expect(byId.series1_20261126T043000Z).toMatchObject({ startsAt: "2026-11-26T04:30:00.000Z", endsAt: "2026-11-26T05:00:00.000Z" });
  });

  it("never returns a title, attendee, location or description, even when Google sends them", async () => {
    const { provider } = setup((_c, _t, request) => json(200, query(request).get("pageToken") ? eventsPage2 : eventsPage1));
    const result = await provider.syncChanges(credentials, "primary", WINDOW);
    for (const field of FORBIDDEN_FIELDS) expect(allKeys(result).has(field)).toBe(false);
    const text = JSON.stringify(result);
    for (const secret of ["Dentist", "root canal", "Bring X-rays", "MG Road", "dr.patel", "cfo@corp", "Board lunch"]) expect(text).not.toContain(secret);
  });

  it("incremental sync sends only the token and reports removed events as cancelled", async () => {
    const { provider, requests } = setup(() => json(200, eventsDelta));
    const result = await provider.syncChanges(credentials, "primary", { ...WINDOW, syncToken: "sync-token-A" });
    if (result.fullResyncRequired) throw new Error("unexpected resync");
    expect(result.mode).toBe("delta");
    expect(result.nextSyncToken).toBe("sync-token-B");
    const sent = query(requests[0] as HttpRequest);
    expect(sent.get("syncToken")).toBe("sync-token-A");
    expect(sent.has("timeMin")).toBe(false);
    expect(result.events[0]).toEqual({ sourceEventId: "evt1", startsAt: null, endsAt: null, cancelled: true, transparent: false, allDay: false });
    expect(result.events[1]).toMatchObject({ sourceEventId: "evt5", cancelled: false });
  });

  it("asks for a full resync when Google answers 410", async () => {
    const { provider } = setup(() => json(410, gone));
    await expect(provider.syncChanges(credentials, "primary", { ...WINDOW, syncToken: "old" })).resolves.toEqual({ fullResyncRequired: true });
  });

  it("a 410 on a full read is an error, not a resync loop", async () => {
    const { provider } = setup(() => json(410, gone));
    await expect(provider.syncChanges(credentials, "primary", WINDOW)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("rejects a response of the wrong shape instead of storing garbage", async () => {
    const { provider } = setup(() => json(200, { items: [{ status: "confirmed" }] }));
    await expect(provider.syncChanges(credentials, "primary", WINDOW)).rejects.toMatchObject({ kind: "invalid" });
  });
});

describe("google adapter: tokens and failures", () => {
  it("reports a refreshed token once and reuses it for later calls", async () => {
    const refreshed: RefreshedTokens = { refreshToken: "refresh-1", accessToken: "access-2", expiresAt: "2026-11-19T12:00:00.000Z" };
    const callback = vi.fn();
    const { provider, seen } = setup((_c, onTokens) => {
      onTokens(refreshed);
      return json(200, { items: [] });
    }, callback);
    await provider.listCalendars(credentials);
    await provider.listCalendars(credentials);
    expect(callback).toHaveBeenCalledWith(refreshed);
    expect(seen[0]?.accessToken).toBe("access-1");
    expect(seen[1]?.accessToken).toBe("access-2");
  });

  it("classifies invalid_grant from the OAuth client as revoked", async () => {
    const { provider } = setup(() => {
      throw Object.assign(new Error("invalid_grant"), { status: 400, response: { status: 400, data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } } });
    });
    const error = await provider.listCalendars(credentials).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "revoked" });
    expect(provider.handleAuthFailure(error)).toEqual({ kind: "revoked" });
  });

  it("does not mark the connection revoked when the app's own client is rejected", async () => {
    const { provider } = setup(() => {
      throw Object.assign(new Error("invalid_client"), { status: 401, response: { status: 401, data: { error: "invalid_client", error_description: "The OAuth client was not found." } } });
    });
    const error = await provider.listCalendars(credentials).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "invalid" });
  });

  it("classifies a 401 as revoked and a missing scope as revoked", async () => {
    expect(await setup(() => json(401, {})).provider.listCalendars(credentials).catch((e: unknown) => e)).toMatchObject({ kind: "revoked" });
    const forbidden = json(403, { error: { errors: [{ reason: "insufficientPermissions" }] } });
    expect(await setup(() => forbidden).provider.listCalendars(credentials).catch((e: unknown) => e)).toMatchObject({ kind: "revoked" });
  });

  it("classifies 429 and quota 403 as rate limited with Retry-After", async () => {
    const limited = await setup(() => json(429, {}, { "retry-after": "30" })).provider.listCalendars(credentials).catch((e: unknown) => e);
    expect(limited).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 30 });
    const { provider } = setup(() => json(403, rateLimit));
    const quota = await provider.listCalendars(credentials).catch((e: unknown) => e);
    expect(provider.handleAuthFailure(quota)).toEqual({ kind: "rate_limited", retryAfterSeconds: 60 });
  });

  it("treats server errors and network failures as transient", async () => {
    const { provider } = setup(() => json(503, {}));
    const error = await provider.listCalendars(credentials).catch((e: unknown) => e);
    expect(provider.handleAuthFailure(error)).toEqual({ kind: "transient" });
    const network = setup(() => {
      throw new Error("socket hang up");
    });
    expect(network.provider.handleAuthFailure(await network.provider.listCalendars(credentials).catch((e: unknown) => e))).toEqual({ kind: "transient" });
  });
});

describe("google adapter: writing", () => {
  const input = { title: "Haircut: Asha", description: "Booked online", start: "2026-11-20T04:30:00Z", end: "2026-11-20T05:30:00Z", timezone: "Asia/Kolkata" };

  it("creates an event without sending invitations and returns the etag", async () => {
    const { provider, requests } = setup(() => json(200, eventWritten));
    const result = await provider.createEvent(credentials, "primary", input);
    expect(result).toEqual({ eventId: "abc123evt", etag: '"3181161784712000"' });
    const sent = requests[0] as HttpRequest;
    expect(sent.method).toBe("POST");
    expect(query(sent).get("sendUpdates")).toBe("none");
    expect(sent.json).toMatchObject({ summary: "Haircut: Asha", start: { dateTime: "2026-11-20T04:30:00Z", timeZone: "Asia/Kolkata" }, transparency: "opaque" });
  });

  it("makes create idempotent: the same key is the same id, and a 409 returns the first event", async () => {
    const responses = [json(409, { error: { code: 409 } }), json(200, eventWritten)];
    const { provider, requests } = setup(() => responses.shift() ?? json(500));
    const result = await provider.createEvent(credentials, "primary", { ...input, idempotencyKey: "outbox-9" });
    expect(result.eventId).toBe("abc123evt");
    const id = (requests[0]?.json as { id: string }).id;
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(requests[1]?.method).toBe("GET");
    expect(requests[1]?.url).toContain(id);
  });

  it("updates with If-Match, and a stale etag is a conflict", async () => {
    const { provider, requests } = setup(() => json(200, eventWritten));
    await provider.updateEvent(credentials, "primary", "abc123evt", input, { etag: '"3181161784712000"' });
    expect(requests[0]?.method).toBe("PATCH");
    expect(requests[0]?.headers?.["if-match"]).toBe('"3181161784712000"');
    const stale = await setup(() => json(412, {})).provider.updateEvent(credentials, "primary", "abc123evt", input, { etag: '"old"' }).catch((e: unknown) => e);
    expect(stale).toMatchObject({ kind: "conflict" });
  });

  it("update of an event deleted outside Kalendr is not_found", async () => {
    const error = await setup(() => json(404, {})).provider.updateEvent(credentials, "primary", "gone", input).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "not_found" });
  });

  it("deletes with If-Match and treats an already-deleted event as done", async () => {
    const { provider, requests } = setup(() => json(204));
    await provider.deleteEvent(credentials, "primary", "abc123evt", { etag: '"e"' });
    expect(requests[0]?.method).toBe("DELETE");
    expect(requests[0]?.headers?.["if-match"]).toBe('"e"');
    await expect(setup(() => json(410, {})).provider.deleteEvent(credentials, "primary", "x")).resolves.toBeUndefined();
    await expect(setup(() => json(404, {})).provider.deleteEvent(credentials, "primary", "x")).resolves.toBeUndefined();
  });
});

describe("google adapter: push channels", () => {
  const watchRequest = { callbackUrl: "https://app.example.test/api/webhooks/google-calendar", token: "shared-secret" };

  it("opens a channel with the shared token and reports its expiry", async () => {
    const { provider, requests } = setup(() => json(200, watchResponse));
    const channel = await provider.watch(credentials, "primary", watchRequest);
    expect(channel).toEqual({ channelId: "chan-uuid", resourceId: "o3hgv1AppC-dxxPQ8s_w7ZoQ", expiresAt: new Date(1795500000000).toISOString() });
    expect(requests[0]?.url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/watch");
    expect(requests[0]?.json).toMatchObject({ type: "web_hook", address: watchRequest.callbackUrl, token: "shared-secret" });
  });

  it("refuses a plain-http callback", async () => {
    const { provider } = setup(() => json(200, watchResponse));
    await expect(provider.watch(credentials, "primary", { ...watchRequest, callbackUrl: "http://insecure.test/hook" })).rejects.toMatchObject({ kind: "invalid" });
  });

  it("stops a channel, treating an unknown one as stopped", async () => {
    const { provider, requests } = setup(() => json(204));
    await provider.stopWatch(credentials, { channelId: "chan-uuid", resourceId: "res" });
    expect(requests[0]?.url).toBe("https://www.googleapis.com/calendar/v3/channels/stop");
    expect(requests[0]?.json).toEqual({ id: "chan-uuid", resourceId: "res" });
    await expect(setup(() => json(404, {})).provider.stopWatch(credentials, { channelId: "x", resourceId: null })).resolves.toBeUndefined();
  });

  it("renews by opening the new channel first, then stopping the old one", async () => {
    const { provider, requests } = setup((_c, _t, request) => (request.url.endsWith("/watch") ? json(200, watchResponse) : json(204)));
    const renewed = await provider.renewWatch(credentials, "primary", { channelId: "old-chan", resourceId: "old-res", expiresAt: "2026-11-20T00:00:00.000Z" }, watchRequest);
    expect(renewed.channelId).toBe("chan-uuid");
    expect(requests.map((request) => request.url.split("/").slice(-2).join("/"))).toEqual(["events/watch", "channels/stop"]);
    expect(requests[1]?.json).toEqual({ id: "old-chan", resourceId: "old-res" });
  });

  it("keeps the new channel even if stopping the old one fails", async () => {
    const { provider } = setup((_c, _t, request) => (request.url.endsWith("/watch") ? json(200, watchResponse) : json(500, {})));
    const renewed = await provider.renewWatch(credentials, "primary", { channelId: "old", resourceId: "r", expiresAt: "2026-11-20T00:00:00.000Z" }, watchRequest);
    expect(renewed.channelId).toBe("chan-uuid");
  });
});

describe("webhook token check", () => {
  it("compares the shared secret", () => {
    expect(webhookTokenMatches("shared-secret", "shared-secret")).toBe(true);
    expect(webhookTokenMatches("shared-secreT", "shared-secret")).toBe(false);
    expect(webhookTokenMatches(null, "shared-secret")).toBe(false);
    expect(webhookTokenMatches("anything", "")).toBe(false);
  });
});
