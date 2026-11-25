import { describe, expect, it } from "vitest";

import { changeLabel, effectiveFrequency, ownerSummarySchema, periodLabel, summaryPeriod } from "./owner-summary";

describe("summaryPeriod", () => {
  it("covers the Monday-to-Sunday week before, Monday to Wednesday", () => {
    // 2026-11-23 is a Monday.
    expect(summaryPeriod("2026-11-23", "weekly")).toEqual({ start: "2026-11-16", end: "2026-11-23", previousStart: "2026-11-09" });
    expect(summaryPeriod("2026-11-25", "weekly")).toEqual({ start: "2026-11-16", end: "2026-11-23", previousStart: "2026-11-09" });
  });

  it("does not send a weekly summary later in the week", () => {
    expect(summaryPeriod("2026-11-26", "weekly")).toBeNull();
    expect(summaryPeriod("2026-11-29", "weekly")).toBeNull();
  });

  it("covers the month before on the 1st to the 3rd", () => {
    expect(summaryPeriod("2026-12-01", "monthly")).toEqual({ start: "2026-11-01", end: "2026-12-01", previousStart: "2026-10-01" });
    expect(summaryPeriod("2026-12-03", "monthly")?.start).toBe("2026-11-01");
    expect(summaryPeriod("2026-12-04", "monthly")).toBeNull();
  });

  it("crosses a year", () => {
    expect(summaryPeriod("2027-01-02", "monthly")).toEqual({ start: "2026-12-01", end: "2027-01-01", previousStart: "2026-11-01" });
    expect(summaryPeriod("2027-01-04", "weekly")).toEqual({ start: "2026-12-28", end: "2027-01-04", previousStart: "2026-12-21" });
  });
});

describe("effectiveFrequency", () => {
  it("gives owners the weekly one until they choose, and nobody else any", () => {
    expect(effectiveFrequency(null, "owner")).toBe("weekly");
    expect(effectiveFrequency(null, "admin")).toBe("off");
    expect(effectiveFrequency("monthly", "owner")).toBe("monthly");
    expect(effectiveFrequency("off", "owner")).toBe("off");
  });
});

describe("wording", () => {
  it("says the change in plain words", () => {
    expect(changeLabel(112, 100)).toBe("up 12%");
    expect(changeLabel(75, 100)).toBe("down 25%");
    expect(changeLabel(5, 5)).toBe("no change");
    expect(changeLabel(4, 0)).toBe("up from none");
    expect(changeLabel(-500, 0)).toBe("down from none");
  });

  it("labels a period", () => {
    expect(periodLabel("2026-11-16", "2026-11-22")).toBe("16 November to 22 November");
  });

  it("rejects a payload with the wrong shape", () => {
    expect(ownerSummarySchema.safeParse({ membershipId: "m" }).success).toBe(false);
  });
});
