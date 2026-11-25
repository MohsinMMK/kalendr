import { describe, expect, it } from "vitest";

import { offerDay } from "./offers-parts";

describe("offerDay", () => {
  const now = new Date("2026-11-21T09:00:00Z");

  it("leaves the year off for a day this year", () => {
    expect(offerDay("2026-12-30T10:00:00Z", now)).toBe("30 December");
  });

  it("shows the year for a day in another year, so a year-long package never reads as ending today", () => {
    expect(offerDay("2027-11-21T10:00:00Z", now)).toBe("21 November 2027");
  });
});
