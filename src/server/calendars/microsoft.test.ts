import { describe, expect, it, vi } from "vitest";

import accessDenied from "./__fixtures__/microsoft-access-denied.json";
import calendars from "./__fixtures__/microsoft-calendars.json";
import deltaIncremental from "./__fixtures__/microsoft-delta-incremental.json";
import deltaPage1 from "./__fixtures__/microsoft-delta-initial-page1.json";
import deltaPage2 from "./__fixtures__/microsoft-delta-initial-page2.json";
import eventCreated from "./__fixtures__/microsoft-event-created.json";
import invalidGrant from "./__fixtures__/microsoft-invalid-grant.json";
import me from "./__fixtures__/microsoft-me.json";
import syncStateNotFound from "./__fixtures__/microsoft-sync-state-not-found.json";
import subscription from "./__fixtures__/microsoft-subscription.json";
import token from "./__fixtures__/microsoft-token.json";
import { MICROSOFT_SCOPES, createMicrosoftProvider } from "./microsoft";
import type { OAuthCalendarProvider, OAuthCredentials, RefreshedTokens } from "./provider";
import { allKeys, FORBIDDEN_FIELDS, json, NOW, scriptedTransport, WINDOW, type Responder } from "./test-support";

const app = { clientId: "ms-client", clientSecret: "ms-secret" };
const fresh: OAuthCredentials = { kind: "oauth", provider: "microsoft", refreshToken: "M.R3_old", accessToken: "access-1", expiresAt: "2026-11-19T11:00:00.000Z" };
const stale: OAuthCredentials = { ...fresh, accessToken: "expired", expiresAt: "2026-11-19T09:00:00.000Z" };
const isToken: Responder = (request) => (request.url.endsWith("/oauth2/v2.0/token") ? json(200, token) : undefined);

function build(onCredentialsRefreshed?: (tokens: RefreshedTokens) => void, ...responders: Responder[]) {
  const { transport, requests } = scriptedTransport(...responders);
  const provider = createMicrosoftProvider({ app, transport, onCredentialsRefreshed, now: () => NOW }) as OAuthCalendarProvider;
  return { provider, requests };
}

describe("microsoft adapter: sign-in", () => {
  it("asks for the narrow Graph scopes and carries the state", () => {
    const { provider } = build();
    const url = new URL(provider.buildAuthUrl("state-9", "https://app.example.test/cb"));
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("state")).toBe("state-9");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...MICROSOFT_SCOPES]);
    expect(url.searchParams.get("scope")).not.toMatch(/Calendars\.ReadWrite\.Shared|Mail|Files/);
  });

  it("exchanges the code and looks up the sign-in address", async () => {
    const { provider, requests } = build(undefined, isToken, (request) => (request.url.includes("/me") ? json(200, me) : undefined));
    const result = await provider.exchangeCode("code-1", "https://app.example.test/cb");
    expect(result).toMatchObject({ refreshToken: "M.R3_refresh-rotated", accessToken: "EwB-access", accountEmail: "asha.rao@contoso.example" });
    expect(result.expiresAt).toBe(new Date(NOW.getTime() + 3599_000).toISOString());
    expect(requests[0]?.form).toMatchObject({ grant_type: "authorization_code", code: "code-1", client_id: "ms-client" });
  });

  it("a rejected code is invalid, not revoked", async () => {
    const { provider } = build(undefined, () => json(400, invalidGrant));
    await expect(provider.exchangeCode("bad", "r")).rejects.toMatchObject({ kind: "invalid" });
  });

  it("rejects a consent without calendar access", async () => {
    const { provider } = build(undefined, () => json(200, { ...token, scope: "User.Read openid" }));
    await expect(provider.exchangeCode("c", "r")).rejects.toMatchObject({ kind: "invalid" });
  });
});

describe("microsoft adapter: token refresh", () => {
  it("does not refresh while the access token is fresh", async () => {
    const { provider, requests } = build(undefined, (request) => (request.url.includes("/me/calendars") ? json(200, calendars) : undefined));
    await provider.listCalendars(fresh);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers?.authorization).toBe("Bearer access-1");
  });

  it("refreshes an expired token, reports the rotated refresh token, and reuses it", async () => {
    const callback = vi.fn();
    const { provider, requests } = build(callback, isToken, (request) => (request.url.includes("/me/calendars") ? json(200, calendars) : undefined));
    await provider.listCalendars(stale);
    await provider.listCalendars(stale);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({ refreshToken: "M.R3_refresh-rotated", accessToken: "EwB-access", expiresAt: new Date(NOW.getTime() + 3599_000).toISOString() });
    expect(requests[0]?.form).toMatchObject({ grant_type: "refresh_token", refresh_token: "M.R3_old" });
    expect(requests.filter((request) => request.url.includes("/token"))).toHaveLength(1);
    expect(requests[2]?.headers?.authorization).toBe("Bearer EwB-access");
  });

  it("retries once after a 401 with a refreshed token", async () => {
    let calls = 0;
    const { provider } = build(undefined, isToken, () => {
      calls += 1;
      return calls === 1 ? json(401, {}) : json(200, calendars);
    });
    await expect(provider.listCalendars(fresh)).resolves.toHaveLength(2);
  });

  it("a 401 that survives a refresh means revoked", async () => {
    const { provider } = build(undefined, isToken, () => json(401, {}));
    const error = await provider.listCalendars(fresh).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "revoked" });
    expect(provider.handleAuthFailure(error)).toEqual({ kind: "revoked" });
  });

  it("AADSTS errors on refresh mean revoked", async () => {
    const { provider } = build(undefined, () => json(400, invalidGrant));
    const error = await provider.listCalendars(stale).catch((e: unknown) => e);
    expect(provider.handleAuthFailure(error)).toEqual({ kind: "revoked" });
  });

  it("a rejected app secret is not the person's grant", async () => {
    const { provider } = build(undefined, () => json(401, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." }));
    const error = await provider.listCalendars(stale).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "invalid" });
    expect(provider.handleAuthFailure(error)).not.toEqual({ kind: "revoked" });
  });

  it("a token endpoint outage is transient", async () => {
    const { provider } = build(undefined, () => json(503, {}));
    expect(provider.handleAuthFailure(await provider.listCalendars(stale).catch((e: unknown) => e))).toEqual({ kind: "transient" });
  });

  it("a removed permission is revoked", async () => {
    const { provider } = build(undefined, () => json(403, accessDenied));
    expect(provider.handleAuthFailure(await provider.listCalendars(fresh).catch((e: unknown) => e))).toEqual({ kind: "revoked" });
  });
});

describe("microsoft adapter: reading", () => {
  it("lists calendars", async () => {
    const { provider } = build(undefined, () => json(200, calendars));
    expect(await provider.listCalendars(fresh)).toEqual([
      { id: "AAMkCal1", name: "Calendar", primary: true, canWrite: true, timezone: null },
      { id: "AAMkCal2", name: "Birthdays", primary: false, canWrite: false, timezone: null },
    ]);
  });

  it("initial sync follows nextLink to the deltaLink and converts every shape of event", async () => {
    const { provider, requests } = build(undefined, (request) => (request.url.includes("skiptoken") ? json(200, deltaPage2) : json(200, deltaPage1)));
    const result = await provider.syncChanges(fresh, "AAMkCal1", WINDOW);
    if (result.fullResyncRequired) throw new Error("unexpected resync");
    expect(result.mode).toBe("snapshot");
    expect(result.nextSyncToken).toBe("https://graph.microsoft.com/v1.0/me/calendars/AAMkCal1/calendarView/delta?$deltatoken=tok1");

    const first = new URL(requests[0]?.url ?? "");
    expect(first.pathname).toBe("/v1.0/me/calendars/AAMkCal1/calendarView/delta");
    expect(first.searchParams.get("startDateTime")).toBe(WINDOW.from.toISOString());
    expect(first.searchParams.get("$select")).not.toMatch(/subject|body|attendees|location|organizer/);
    expect(requests[0]?.headers?.prefer).toContain('outlook.timezone="UTC"');

    const byId = Object.fromEntries(result.events.map((event) => [event.sourceEventId, event]));
    expect(byId.evA).toMatchObject({ startsAt: "2026-11-20T04:30:00.000Z", endsAt: "2026-11-20T05:30:00.000Z", cancelled: false, transparent: false, allDay: false });
    expect(byId.evB).toMatchObject({ allDay: true, startsAt: "2026-11-21T00:00:00.000Z" });
    expect(byId.evC?.transparent).toBe(true); // showAs free
    expect(byId.evD?.transparent).toBe(true); // declined
    expect(byId.evE).toMatchObject({ startsAt: "2026-11-26T04:30:00.000Z" }); // series occurrence, already expanded
    expect(byId.evF?.cancelled).toBe(true);
  });

  it("never returns a title, attendee, location or body, even when Graph sends them", async () => {
    const { provider } = build(undefined, (request) => (request.url.includes("skiptoken") ? json(200, deltaPage2) : json(200, deltaPage1)));
    const result = await provider.syncChanges(fresh, "AAMkCal1", WINDOW);
    for (const field of FORBIDDEN_FIELDS) expect(allKeys(result).has(field)).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/Private appointment|someone@else/);
  });

  it("incremental sync calls the stored deltaLink and maps @removed to cancelled", async () => {
    const link = "https://graph.microsoft.com/v1.0/me/calendars/AAMkCal1/calendarView/delta?$deltatoken=tok1";
    const { provider, requests } = build(undefined, () => json(200, deltaIncremental));
    const result = await provider.syncChanges(fresh, "AAMkCal1", { ...WINDOW, syncToken: link });
    if (result.fullResyncRequired) throw new Error("unexpected resync");
    expect(requests[0]?.url).toBe(link);
    expect(result.mode).toBe("delta");
    expect(result.nextSyncToken).toContain("tok2");
    expect(result.events[0]).toEqual({ sourceEventId: "evA", startsAt: null, endsAt: null, cancelled: true });
    expect(result.events[1]).toMatchObject({ sourceEventId: "evG", cancelled: false });
  });

  it("asks for a full resync when the delta state is gone (410 or syncStateNotFound)", async () => {
    const link = "https://graph.microsoft.com/v1.0/me/calendars/AAMkCal1/calendarView/delta?$deltatoken=old";
    for (const response of [json(410, syncStateNotFound), json(400, syncStateNotFound)]) {
      const { provider } = build(undefined, () => response);
      await expect(provider.syncChanges(fresh, "AAMkCal1", { ...WINDOW, syncToken: link })).resolves.toEqual({ fullResyncRequired: true });
    }
  });

  it("never sends the bearer token to an address that is not Graph", async () => {
    const { provider, requests } = build(undefined, () => json(200, { value: [], "@odata.nextLink": "https://evil.example/steal" }));
    await expect(provider.syncChanges(fresh, "AAMkCal1", WINDOW)).rejects.toMatchObject({ kind: "invalid" });
    expect(requests.every((request) => new URL(request.url).hostname === "graph.microsoft.com")).toBe(true);
    await expect(provider.syncChanges(fresh, "AAMkCal1", { ...WINDOW, syncToken: "https://evil.example/delta" })).rejects.toMatchObject({ kind: "invalid" });
  });

  it("classifies 429 and 503 with Retry-After as rate limited", async () => {
    for (const status of [429, 503]) {
      const { provider } = build(undefined, () => json(status, {}, { "retry-after": "17" }));
      const error = await provider.listCalendars(fresh).catch((e: unknown) => e);
      expect(provider.handleAuthFailure(error)).toEqual({ kind: "rate_limited", retryAfterSeconds: 17 });
    }
  });
});

describe("microsoft adapter: writing", () => {
  const input = { title: "Haircut: Asha", description: "Booked online", start: "2026-11-20T04:30:00Z", end: "2026-11-20T05:30:00Z", timezone: "Asia/Kolkata" };

  it("creates in UTC with a transaction id and returns the etag", async () => {
    const { provider, requests } = build(undefined, () => json(201, eventCreated));
    const result = await provider.createEvent(fresh, "AAMkCal1", { ...input, idempotencyKey: "outbox-3" });
    expect(result).toEqual({ eventId: "AAMkEvt1", etag: 'W/"DwAAABYAAAB"' });
    expect(requests[0]?.url).toBe("https://graph.microsoft.com/v1.0/me/calendars/AAMkCal1/events");
    expect(requests[0]?.json).toMatchObject({
      subject: "Haircut: Asha",
      start: { dateTime: "2026-11-20T04:30:00.0000000", timeZone: "UTC" },
      showAs: "busy",
      transactionId: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("updates with If-Match; a stale etag is a conflict; a deleted event is not_found", async () => {
    const ok = build(undefined, () => json(200, eventCreated));
    await ok.provider.updateEvent(fresh, "AAMkCal1", "AAMkEvt1", input, { etag: 'W/"old"' });
    expect(ok.requests[0]?.method).toBe("PATCH");
    expect(ok.requests[0]?.headers?.["if-match"]).toBe('W/"old"');
    expect(await build(undefined, () => json(412, {})).provider.updateEvent(fresh, "c", "e", input, { etag: "x" }).catch((e: unknown) => e)).toMatchObject({ kind: "conflict" });
    expect(await build(undefined, () => json(404, {})).provider.updateEvent(fresh, "c", "e", input).catch((e: unknown) => e)).toMatchObject({ kind: "not_found" });
  });

  it("deletes with If-Match and treats a missing event as deleted", async () => {
    const { provider, requests } = build(undefined, () => json(204));
    await provider.deleteEvent(fresh, "AAMkCal1", "AAMkEvt1", { etag: 'W/"e"' });
    expect(requests[0]?.method).toBe("DELETE");
    expect(requests[0]?.headers?.["if-match"]).toBe('W/"e"');
    await expect(build(undefined, () => json(404, {})).provider.deleteEvent(fresh, "c", "e")).resolves.toBeUndefined();
  });
});

describe("microsoft adapter: subscriptions", () => {
  const watchRequest = { callbackUrl: "https://app.example.test/api/webhooks/microsoft-graph", token: "shared-secret" };

  it("creates a subscription under the 4230-minute event limit with the shared clientState", async () => {
    const { provider, requests } = build(undefined, () => json(201, subscription));
    const channel = await provider.watch(fresh, "AAMkCal1", watchRequest);
    expect(channel).toEqual({ channelId: "sub-7f105c", resourceId: null, expiresAt: "2026-11-22T03:00:00.000Z" });
    const body = requests[0]?.json as { expirationDateTime: string; clientState: string; resource: string; notificationUrl: string };
    expect(body).toMatchObject({ clientState: "shared-secret", resource: "/me/calendars/AAMkCal1/events", notificationUrl: watchRequest.callbackUrl });
    expect(Date.parse(body.expirationDateTime) - NOW.getTime()).toBeLessThanOrEqual(4230 * 60_000);
  });

  it("renews the same subscription with PATCH", async () => {
    const { provider, requests } = build(undefined, () => json(200, subscription));
    const renewed = await provider.renewWatch(fresh, "AAMkCal1", { channelId: "sub-7f105c", resourceId: null, expiresAt: "2026-11-20T00:00:00.000Z" }, watchRequest);
    expect(renewed.channelId).toBe("sub-7f105c");
    expect(requests[0]?.method).toBe("PATCH");
    expect(requests[0]?.url).toBe("https://graph.microsoft.com/v1.0/subscriptions/sub-7f105c");
  });

  it("creates a new subscription when the old one is already gone", async () => {
    const responses = [json(404, {}), json(201, { ...subscription, id: "sub-new" })];
    const { provider, requests } = build(undefined, () => responses.shift());
    const renewed = await provider.renewWatch(fresh, "AAMkCal1", { channelId: "sub-dead", resourceId: null, expiresAt: "2026-11-20T00:00:00.000Z" }, watchRequest);
    expect(renewed.channelId).toBe("sub-new");
    expect(requests.map((request) => request.method)).toEqual(["PATCH", "POST"]);
  });

  it("deletes a subscription and tolerates one that is already gone", async () => {
    const { provider, requests } = build(undefined, () => json(204));
    await provider.stopWatch(fresh, { channelId: "sub-7f105c", resourceId: null });
    expect(requests[0]?.method).toBe("DELETE");
    await expect(build(undefined, () => json(404, {})).provider.stopWatch(fresh, { channelId: "x", resourceId: null })).resolves.toBeUndefined();
  });

  it("refuses a plain-http callback", async () => {
    const { provider } = build(undefined, () => json(201, subscription));
    await expect(provider.watch(fresh, "c", { ...watchRequest, callbackUrl: "http://x.test" })).rejects.toMatchObject({ kind: "invalid" });
  });
});
