import { describe, expect, it, vi } from "vitest";

import { calendarConfigFromEnv, isProviderConfigured } from "./config";
import { CalendarProviderError, classifyFailure, parseRetryAfter } from "./errors";
import { FakeCalendarProvider } from "./fake";
import { createFetchTransport } from "./http";
import { busyEventSchema, isOAuthProvider, providerCredentialsSchema } from "./provider";
import { configuredProviders, createCalendarProvider } from "./registry";
import { NOW } from "./test-support";

const full = calendarConfigFromEnv({
  GOOGLE_CALENDAR_CLIENT_ID: "g-id",
  GOOGLE_CALENDAR_CLIENT_SECRET: "g-secret",
  MICROSOFT_CALENDAR_CLIENT_ID: "m-id",
  MICROSOFT_CALENDAR_CLIENT_SECRET: "m-secret",
  CALENDAR_WEBHOOK_TOKEN: "hook",
});

describe("calendar config", () => {
  it("is switched off by empty keys rather than failing", () => {
    const config = calendarConfigFromEnv({ GOOGLE_CALENDAR_CLIENT_ID: "only-id", MICROSOFT_CALENDAR_CLIENT_ID: "", MICROSOFT_CALENDAR_CLIENT_SECRET: "  " });
    expect(config).toEqual({ google: null, microsoft: null, webhookToken: null });
    expect(isProviderConfigured(config, "google")).toBe(false);
    expect(isProviderConfigured(config, "apple")).toBe(true);
  });

  it("reads the five variables", () => {
    expect(full).toEqual({ google: { clientId: "g-id", clientSecret: "g-secret" }, microsoft: { clientId: "m-id", clientSecret: "m-secret" }, webhookToken: "hook" });
  });
});

describe("registry", () => {
  it("builds each adapter with the right shape", () => {
    const google = createCalendarProvider("google", { config: full });
    const microsoft = createCalendarProvider("microsoft", { config: full });
    const apple = createCalendarProvider("apple", { config: full });
    expect([google.id, microsoft.id, apple.id]).toEqual(["google", "microsoft", "apple"]);
    expect([google.supportsPush, microsoft.supportsPush, apple.supportsPush]).toEqual([true, true, false]);
    expect([isOAuthProvider(google), isOAuthProvider(microsoft), isOAuthProvider(apple)]).toEqual([true, true, false]);
  });

  it("refuses a provider whose keys are empty", () => {
    const empty = calendarConfigFromEnv({});
    expect(() => createCalendarProvider("google", { config: empty })).toThrow(CalendarProviderError);
    expect(configuredProviders({ config: empty })).toEqual(["apple"]);
    expect(configuredProviders({ config: full })).toEqual(["google", "microsoft", "apple"]);
  });

  it("lets a test swap in the fake", () => {
    const fake = new FakeCalendarProvider();
    expect(createCalendarProvider("google", { config: calendarConfigFromEnv({}), overrides: { google: fake } })).toBe(fake);
    expect(configuredProviders({ config: calendarConfigFromEnv({}), overrides: { google: fake } })).toEqual(["google", "apple"]);
  });
});

describe("failure classification", () => {
  it("maps adapter errors, and treats anything unknown as transient", () => {
    expect(classifyFailure(new CalendarProviderError("revoked", "x"))).toEqual({ kind: "revoked" });
    expect(classifyFailure(new CalendarProviderError("rate_limited", "x", { retryAfterSeconds: 5 }))).toEqual({ kind: "rate_limited", retryAfterSeconds: 5 });
    expect(classifyFailure(new CalendarProviderError("conflict", "x"))).toEqual({ kind: "transient" });
    expect(classifyFailure(new Error("boom"))).toEqual({ kind: "transient" });
  });

  it("parses Retry-After as seconds or a date", () => {
    expect(parseRetryAfter("30", NOW)).toBe(30);
    expect(parseRetryAfter("Thu, 19 Nov 2026 10:01:00 GMT", NOW)).toBe(60);
    expect(parseRetryAfter("soon", NOW)).toBeNull();
    expect(parseRetryAfter(undefined, NOW)).toBeNull();
  });
});

describe("shared schemas", () => {
  it("the busy schema is strict: a title cannot be smuggled in", () => {
    const base = { sourceEventId: "e", startsAt: "2026-11-20T04:30:00.000Z", endsAt: "2026-11-20T05:30:00.000Z", cancelled: false };
    expect(busyEventSchema.safeParse(base).success).toBe(true);
    expect(busyEventSchema.safeParse({ ...base, title: "Dentist" }).success).toBe(false);
    expect(busyEventSchema.safeParse({ ...base, attendees: [] }).success).toBe(false);
  });

  it("validates stored credentials by kind", () => {
    expect(providerCredentialsSchema.safeParse({ kind: "oauth", provider: "google", refreshToken: "r" }).success).toBe(true);
    expect(providerCredentialsSchema.safeParse({ kind: "caldav", provider: "apple", serverUrl: "https://caldav.icloud.com", username: "u", appPassword: "p" }).success).toBe(true);
    expect(providerCredentialsSchema.safeParse({ kind: "caldav", provider: "apple", serverUrl: "not a url", username: "u", appPassword: "p" }).success).toBe(false);
  });
});

describe("fetch transport", () => {
  it("parses JSON, lower-cases headers and turns network failure into a transient error", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Retry-After": "3" } }));
    const response = await createFetchTransport(fetchImpl)({ method: "POST", url: "https://x.test", form: { a: "b" } });
    expect(response).toEqual({ status: 200, headers: { "retry-after": "3", "content-type": "text/plain;charset=UTF-8" }, body: { ok: true } });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.body).toBe("a=b");
    const failing = createFetchTransport(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(failing({ method: "GET", url: "https://x.test" })).rejects.toMatchObject({ kind: "transient" });
  });
});
