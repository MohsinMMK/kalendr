/** @vitest-environment node */

import { afterEach, describe, expect, it, vi } from "vitest";

const warn = vi.fn();
vi.mock("server-only", () => ({}));
vi.mock("@/db/client", () => ({ getDatabase: () => null }));
vi.mock("@/server/logger", () => ({ logger: () => ({ warn }) }));

import {
  clientAddress,
  deleteExpiredRateLimitBuckets,
  hitRateLimit,
  rateLimitKeyHash,
  rateLimitWindow,
  recordRefusal,
} from "@/server/rate-limit";
import { rateLimitRuleNames, rateLimitRules } from "@/server/rate-limit-rules";

const forwarded = (value: string) => new Headers({ "x-forwarded-for": value });

describe("rate limit windows and keys", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("aligns windows to the epoch, so every server agrees on them", () => {
    const window = rateLimitWindow(15 * 60, new Date("2026-11-12T10:07:30Z"));
    expect(window.start.toISOString()).toBe("2026-11-12T10:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-11-12T10:15:00.000Z");
  });

  it("stores only a hash, different per rule, keyed with the auth secret when there is one", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    const plain = rateLimitKeyHash("booking.ip", "203.0.113.9");
    expect(plain).toMatch(/^[0-9a-f]{64}$/);
    expect(plain).not.toContain("203.0.113.9");
    expect(rateLimitKeyHash("availability.ip", "203.0.113.9")).not.toBe(plain);
    vi.stubEnv("BETTER_AUTH_SECRET", "a-test-secret-that-is-long-enough-123456");
    expect(rateLimitKeyHash("booking.ip", "203.0.113.9")).not.toBe(plain);
  });

  it("keeps every limit from the plan in the one rules file", () => {
    // A floor, not an exact count, so a lane that adds a rule does not have to edit this line.
    expect(rateLimitRuleNames.length).toBeGreaterThanOrEqual(15);
    expect(rateLimitRules["magic_link.email"]).toMatchObject({ limit: 5, windowSeconds: 900 });
    expect(rateLimitRules["magic_link.ip"]).toMatchObject({ limit: 10, windowSeconds: 900 });
    expect(rateLimitRuleNames).toEqual(expect.arrayContaining(["holds.ip", "email_check.ip", "email_check.email", "email_check_verify.ip"]));
    expect(rateLimitRules["visit.token"]).toMatchObject({ limit: 600, windowSeconds: 600 });
    expect(rateLimitRules["registration.ip"]).toMatchObject({ limit: 5, windowSeconds: 900 });
    expect(rateLimitRules["staff_sign_in.ip"]).toMatchObject({ limit: 10, windowSeconds: 900 });
    expect(rateLimitRules["staff_sign_in.email"]).toMatchObject({ limit: 10, windowSeconds: 900 });
    expect(rateLimitRules["code_request.contact"]).toMatchObject({ limit: 5, windowSeconds: 3600 });
    expect(rateLimitRules["code_request.ip"]).toMatchObject({ limit: 5, windowSeconds: 3600 });
    expect(rateLimitRules["code_verify.ip"]).toMatchObject({ limit: 30, windowSeconds: 3600 });
    expect(rateLimitRules["availability.ip"]).toMatchObject({ limit: 120, windowSeconds: 60 });
    expect(rateLimitRules["booking.ip"]).toMatchObject({ limit: 10, windowSeconds: 3600 });
    expect(rateLimitRules["booking.contact"]).toMatchObject({ limit: 5, windowSeconds: 3600 });
    expect(rateLimitRules["manage_link.token"]).toMatchObject({ limit: 20, windowSeconds: 3600 });
    expect(rateLimitRules["queue_read.ip"]).toMatchObject({ limit: 120, windowSeconds: 60 });
    expect(rateLimitRules["queue_join.ip"]).toMatchObject({ limit: 10, windowSeconds: 600 });
    expect(rateLimitRules["queue_join.link"]).toMatchObject({ limit: 100, windowSeconds: 3600 });
    expect(rateLimitRules["holds.ip"]).toMatchObject({ limit: 40, windowSeconds: 60 });
    expect(rateLimitRules["email_check.email"]).toMatchObject({ limit: 5, windowSeconds: 3600 });
    expect(rateLimitRules["email_check.ip"]).toMatchObject({ limit: 20, windowSeconds: 3600 });
  });
});

describe("counting without a database (the preview)", () => {
  it("allows up to the limit, refuses the next, and says when to retry", async () => {
    const now = new Date("2026-11-12T10:10:00Z");
    const key = "198.51.100.1";
    const results = [];
    for (let attempt = 0; attempt < 6; attempt += 1) results.push(await hitRateLimit("registration.ip", key, { now, database: null }));
    expect(results.map((result) => result.count)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(results.map((result) => result.allowed)).toEqual([true, true, true, true, true, false]);
    expect(results[5]).toMatchObject({ limit: 5, retryAfterSeconds: 300 });
    expect(results[5]?.resetAt.toISOString()).toBe("2026-11-12T10:15:00.000Z");

    // A new window starts again from one; other keys never shared the count.
    expect(await hitRateLimit("registration.ip", key, { now: new Date("2026-11-12T10:15:00Z"), database: null })).toMatchObject({ count: 1, allowed: true });
    expect(await hitRateLimit("registration.ip", "198.51.100.2", { now, database: null })).toMatchObject({ count: 1 });
  });

  it("cleans up windows that ended more than a day ago", async () => {
    const old = new Date("2026-01-01T00:00:00Z");
    await hitRateLimit("availability.ip", "192.0.2.77", { now: old, database: null });
    expect(await deleteExpiredRateLimitBuckets(new Date("2026-11-12T00:00:00Z"), null)).toBeGreaterThan(0);
    expect(await hitRateLimit("availability.ip", "192.0.2.77", { now: old, database: null })).toMatchObject({ count: 1 });
  });
});

describe("client addresses", () => {
  it("reads the entry the trusted proxies wrote and ignores what the client put before it", () => {
    expect(clientAddress(forwarded("6.6.6.6, 203.0.113.5"), 1)).toBe("203.0.113.5");
    expect(clientAddress(forwarded("6.6.6.6, 203.0.113.5, 10.0.0.2"), 2)).toBe("203.0.113.5");
    // More hops than entries: the leftmost, which a proxy still wrote.
    expect(clientAddress(forwarded("203.0.113.5"), 3)).toBe("203.0.113.5");
  });

  it("uses the rightmost entry with no proxies (local development only)", () => {
    expect(clientAddress(forwarded("6.6.6.6, 127.0.0.1"), 0)).toBe("127.0.0.1");
  });

  it("strips ports and IPv4-mapped prefixes, and counts IPv6 clients per /64", () => {
    expect(clientAddress(forwarded("203.0.113.5:44321"), 1)).toBe("203.0.113.5");
    expect(clientAddress(forwarded("::ffff:203.0.113.5"), 1)).toBe("203.0.113.5");
    expect(clientAddress(forwarded("[2001:db8:85a3:1:aaaa:bbbb:cccc:dddd]:443"), 1)).toBe("2001:db8:85a3:1::/64");
    expect(clientAddress(forwarded("2001:DB8:85a3:1::42"), 1)).toBe("2001:db8:85a3:1::/64");
    expect(clientAddress(forwarded("2001:db8::1"), 1)).toBe("2001:db8:0:0::/64");
  });

  it("falls back to one shared key when there is no header", () => {
    expect(clientAddress(new Headers(), 1)).toBe("unknown");
  });
});

describe("refusal counts", () => {
  it("logs the rule name only, never the key", () => {
    recordRefusal("booking.ip");
    expect(warn).toHaveBeenCalledWith({ event: "rate_limit.refused", rule: "booking.ip" }, "request refused");
  });
});
