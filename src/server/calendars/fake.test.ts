import { describe, expect, it, vi } from "vitest";

import { CalendarProviderError } from "./errors";
import { FakeCalendarProvider } from "./fake";
import { busyEventSchema, type ProviderCredentials } from "./provider";
import { allKeys, FORBIDDEN_FIELDS, NOW, WINDOW } from "./test-support";

const credentials: ProviderCredentials = { kind: "oauth", provider: "google", refreshToken: "r", accessToken: "a", expiresAt: null };
const input = { title: "Secret title", start: "2026-11-20T04:30:00Z", end: "2026-11-20T05:30:00Z", timezone: "UTC" };

function setup() {
  const provider = new FakeCalendarProvider({ now: () => NOW });
  provider.addCalendar("cal-1", "Work");
  return provider;
}

describe("FakeCalendarProvider", () => {
  it("gives a snapshot first and then deltas with deterministic tokens", async () => {
    const provider = setup();
    provider.addEvent("cal-1", { id: "e1", startsAt: "2026-11-20T09:00:00Z", endsAt: "2026-11-20T10:00:00Z" });
    const first = await provider.syncChanges(credentials, "cal-1", WINDOW);
    expect(first).toMatchObject({ mode: "snapshot", nextSyncToken: "fake:1:1" });

    provider.addEvent("cal-1", { id: "e2", startsAt: "2026-11-21T09:00:00Z", endsAt: "2026-11-21T10:00:00Z", transparent: true });
    const second = await provider.syncChanges(credentials, "cal-1", { ...WINDOW, syncToken: "fake:1:1" });
    if (second.fullResyncRequired) throw new Error("unexpected resync");
    expect(second.mode).toBe("delta");
    expect(second.events.map((event) => event.sourceEventId)).toEqual(["e2"]);
    expect(second.events[0]?.transparent).toBe(true);
    expect(second.nextSyncToken).toBe("fake:1:2");
  });

  it("reports moves and removals in the next delta", async () => {
    const provider = setup();
    provider.addEvent("cal-1", { id: "e1", startsAt: "2026-11-20T09:00:00Z", endsAt: "2026-11-20T10:00:00Z" });
    provider.addEvent("cal-1", { id: "e2", startsAt: "2026-11-21T09:00:00Z", endsAt: "2026-11-21T10:00:00Z" });
    provider.moveEvent("cal-1", "e1", "2026-11-22T09:00:00Z", "2026-11-22T10:00:00Z");
    provider.removeEvent("cal-1", "e2");
    const delta = await provider.syncChanges(credentials, "cal-1", { ...WINDOW, syncToken: "fake:1:0" });
    if (delta.fullResyncRequired) throw new Error("unexpected resync");
    expect(delta.events).toEqual([
      { sourceEventId: "e1", startsAt: "2026-11-22T09:00:00Z", endsAt: "2026-11-22T10:00:00Z", cancelled: false, transparent: false, allDay: false },
      { sourceEventId: "e2", startsAt: null, endsAt: null, cancelled: true },
    ]);
  });

  it("rejects old tokens after expireSyncTokens (full resync)", async () => {
    const provider = setup();
    const first = await provider.syncChanges(credentials, "cal-1", WINDOW);
    provider.expireSyncTokens();
    const token = first.fullResyncRequired ? null : first.nextSyncToken;
    expect(await provider.syncChanges(credentials, "cal-1", { ...WINDOW, syncToken: token })).toEqual({ fullResyncRequired: true });
    expect(await provider.syncChanges(credentials, "cal-1", { ...WINDOW, syncToken: "garbage" })).toEqual({ fullResyncRequired: true });
  });

  it("everything it returns passes the strict busy schema and carries no title", async () => {
    const provider = setup();
    await provider.createEvent(credentials, "cal-1", input);
    provider.addEvent("cal-1", { startsAt: "2026-11-21T09:00:00Z", endsAt: "2026-11-21T10:00:00Z" });
    const result = await provider.syncChanges(credentials, "cal-1", WINDOW);
    if (result.fullResyncRequired) throw new Error("unexpected resync");
    result.events.forEach((event) => expect(busyEventSchema.safeParse(event).success).toBe(true));
    for (const field of FORBIDDEN_FIELDS) expect(allKeys(result).has(field)).toBe(false);
    expect(JSON.stringify(result)).not.toContain("Secret title");
  });

  it("simulates revocation and classifies it", async () => {
    const provider = setup();
    provider.revoke();
    const error = await provider.listCalendars().catch((caught: unknown) => caught);
    expect(provider.handleAuthFailure(error)).toEqual({ kind: "revoked" });
    provider.restore();
    await expect(provider.listCalendars()).resolves.toHaveLength(1);
  });

  it("injects failures for one call, or several", async () => {
    const provider = setup();
    provider.rateLimitNext("syncChanges", 45);
    const error = await provider.syncChanges(credentials, "cal-1", WINDOW).catch((caught: unknown) => caught);
    expect(provider.handleAuthFailure(error)).toEqual({ kind: "rate_limited", retryAfterSeconds: 45 });
    await expect(provider.syncChanges(credentials, "cal-1", WINDOW)).resolves.toMatchObject({ mode: "snapshot" });
    provider.failNext("any", new CalendarProviderError("transient", "boom"), 2);
    await expect(provider.listCalendars()).rejects.toThrow("boom");
    await expect(provider.verifyAccount()).rejects.toThrow("boom");
    await expect(provider.verifyAccount()).resolves.toBeDefined();
  });

  it("reports refreshed tokens through the callback", async () => {
    const callback = vi.fn();
    const provider = new FakeCalendarProvider({ onCredentialsRefreshed: callback });
    provider.refreshOnNextCall({ refreshToken: "r2", accessToken: "a2", expiresAt: "2026-11-19T12:00:00.000Z" });
    await provider.verifyAccount();
    await provider.verifyAccount();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("writes with etags, idempotency and conflicts", async () => {
    const provider = setup();
    const created = await provider.createEvent(credentials, "cal-1", { ...input, idempotencyKey: "k1" });
    const again = await provider.createEvent(credentials, "cal-1", { ...input, idempotencyKey: "k1" });
    expect(again).toEqual(created);
    expect(provider.event("cal-1", created.eventId)?.createdByKalendr).toBe(true);

    const updated = await provider.updateEvent(credentials, "cal-1", created.eventId, { ...input, title: "Moved" }, { etag: created.etag });
    expect(updated.etag).not.toBe(created.etag);
    await expect(provider.updateEvent(credentials, "cal-1", created.eventId, input, { etag: created.etag })).rejects.toMatchObject({ kind: "conflict" });

    await provider.deleteEvent(credentials, "cal-1", created.eventId);
    await expect(provider.deleteEvent(credentials, "cal-1", created.eventId)).resolves.toBeUndefined();
    await expect(provider.updateEvent(credentials, "cal-1", created.eventId, input)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("opens, renews and stops channels, and lets tests find who to notify", async () => {
    const provider = setup();
    const channel = await provider.watch(credentials, "cal-1", { callbackUrl: "https://app.example.test/hook", token: "t" });
    expect(provider.channelsFor("cal-1")).toHaveLength(1);
    const renewed = await provider.renewWatch(credentials, "cal-1", channel, { callbackUrl: "https://app.example.test/hook", token: "t" });
    expect(renewed.channelId).not.toBe(channel.channelId);
    expect(provider.channelsFor("cal-1").map((entry) => entry.channelId)).toEqual([renewed.channelId]);
    await provider.stopWatch(credentials, renewed);
    expect(provider.channels.size).toBe(0);
  });

  it("can pose as CalDAV: no push", async () => {
    const provider = new FakeCalendarProvider({ id: "apple", supportsPush: false });
    provider.addCalendar("c");
    await expect(provider.watch(credentials, "c", { callbackUrl: "https://x.test", token: "t" })).rejects.toMatchObject({ kind: "unsupported" });
  });

  it("completes the OAuth round trip with a known code", async () => {
    const provider = setup();
    expect(provider.buildAuthUrl("s", "https://app.example.test/cb")).toContain("state=s");
    await expect(provider.exchangeCode("good-code")).resolves.toMatchObject({ accountEmail: "staff@example.test" });
    await expect(provider.exchangeCode("nope")).rejects.toMatchObject({ kind: "invalid" });
  });
});
