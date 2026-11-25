import { describe, expect, it } from "vitest";

import { hashShortLinkCode, shortLinkCode, shortLinkExpiry, shortLinkUrl, SHORT_CODE_PATTERN } from "./short-link-code";

const keyA = Buffer.from("a".repeat(32)).toString("base64");
const keyB = Buffer.from("b".repeat(32)).toString("base64");

describe("short link code", () => {
  it("is 10 base62 characters and the same every time", () => {
    const code = shortLinkCode("tenant-1", "appt-1", "hash-1", { KALENDR_RECORDS_KEY: keyA });
    expect(code).toMatch(SHORT_CODE_PATTERN);
    expect(shortLinkCode("tenant-1", "appt-1", "hash-1", { KALENDR_RECORDS_KEY: keyA })).toBe(code);
  });

  it("differs by booking, by business, by manage token and by server key", () => {
    const source = { KALENDR_RECORDS_KEY: keyA };
    const code = shortLinkCode("tenant-1", "appt-1", "hash-1", source);
    expect(shortLinkCode("tenant-1", "appt-2", "hash-1", source)).not.toBe(code);
    expect(shortLinkCode("tenant-2", "appt-1", "hash-1", source)).not.toBe(code);
    expect(shortLinkCode("tenant-1", "appt-1", "hash-2", source)).not.toBe(code);
    expect(shortLinkCode("tenant-1", "appt-1", "hash-1", { KALENDR_RECORDS_KEY: keyB })).not.toBe(code);
  });

  it("stores a hash, builds the url and expires 30 days after the booking ends", () => {
    expect(hashShortLinkCode("abcdefghij")).toMatch(/^[0-9a-f]{64}$/);
    expect(shortLinkUrl("https://k.in/", "abcdefghij")).toBe("https://k.in/m/abcdefghij");
    expect(shortLinkExpiry(new Date("2026-12-01T10:00:00Z")).toISOString()).toBe("2026-12-31T10:00:00.000Z");
  });
});
