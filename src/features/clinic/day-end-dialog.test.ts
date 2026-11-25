import { describe, expect, it } from "vitest";

import { parseCashCount, recentDays } from "./day-end-dialog";

describe("day end", () => {
  it("lists the last week, newest first, across a month end", () => {
    const days = recentDays("2026-12-02", 4);
    expect(days.map((day) => day.value)).toEqual(["2026-12-02", "2026-12-01", "2026-11-30", "2026-11-29"]);
    expect(days[0]!.label).toBe("Today");
    expect(days[1]!.label).toBe("Yesterday");
    expect(days[2]!.label).toMatch(/30 Nov/);
  });

  it("reads a cash count, where an empty drawer is a real zero", () => {
    expect(parseCashCount("0")).toBe(0);
    expect(parseCashCount("₹2,400.5")).toBe(2_40_050);
    expect(parseCashCount("")).toBeNull();
    expect(parseCashCount("-10")).toBeNull();
    expect(parseCashCount("12.345")).toBeNull();
  });
});
