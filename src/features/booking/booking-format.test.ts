import { describe, expect, it } from "vitest";

import { formatTimeZoneName } from "./booking-format";

describe("formatTimeZoneName", () => {
  it("names the zone in words rather than an IANA id", () => {
    expect(formatTimeZoneName("Asia/Kolkata", "en-IN")).toBe("India Standard Time");
  });

  it("follows daylight saving for the given date", () => {
    expect(formatTimeZoneName("America/New_York", "en-US", new Date("2026-07-01T12:00:00Z"))).toBe("Eastern Daylight Time");
    expect(formatTimeZoneName("America/New_York", "en-US", new Date("2026-01-01T12:00:00Z"))).toBe("Eastern Standard Time");
  });
});
