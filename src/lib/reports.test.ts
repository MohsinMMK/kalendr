import { describe, expect, it } from "vitest";

import { addDays, changeFrom, daysBetween, exportRequestSchema, formatReportValue, previousRange, ratePercent, reportParamsSchema, utilisationPercent } from "./reports";

describe("report maths", () => {
  it("reads 20 booked hours of 40 available as 50%", () => {
    expect(utilisationPercent(20, 40)).toBe(50);
    expect(utilisationPercent(0, 40)).toBe(0);
    expect(utilisationPercent(5, 0)).toBeNull();
  });

  it("has no rate when nothing was due", () => {
    expect(ratePercent(1, 0)).toBeNull();
    expect(ratePercent(1, 3)).toBe(33.3);
  });

  it("compares with the period of equal length just before", () => {
    expect(previousRange({ from: "2026-09-01", to: "2026-09-30" })).toEqual({ from: "2026-08-02", to: "2026-08-31" });
    expect(previousRange({ from: "2026-03-01", to: "2026-03-01" })).toEqual({ from: "2026-02-28", to: "2026-02-28" });
    expect(daysBetween("2026-09-01", "2026-09-30")).toBe(29);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("gives no change against zero or a missing figure", () => {
    expect(changeFrom(12, 10)).toBe(20);
    expect(changeFrom(5, 10)).toBe(-50);
    expect(changeFrom(5, 0)).toBeNull();
    expect(changeFrom(5, undefined)).toBeNull();
  });

  it("formats money, percent and hours the way the screen shows them", () => {
    expect(formatReportValue(190000, "money", "INR")).toContain("1,900");
    expect(formatReportValue(12.5, "percent", "INR")).toBe("12.5%");
    expect(formatReportValue(null, "count", "INR")).toBe("—");
    expect(formatReportValue(20, "hours", "INR")).toBe("20 h");
  });
});

describe("report parameters", () => {
  it("accepts a normal range and refuses a backwards or oversized one", () => {
    expect(reportParamsSchema.safeParse({ from: "2026-09-01", to: "2026-09-30" }).success).toBe(true);
    expect(reportParamsSchema.safeParse({ from: "2026-09-30", to: "2026-09-01" }).success).toBe(false);
    expect(reportParamsSchema.safeParse({ from: "2020-01-01", to: "2026-09-01" }).success).toBe(false);
    expect(reportParamsSchema.safeParse({ from: "2026-13-01", to: "2026-14-01" }).success).toBe(false);
    expect(exportRequestSchema.safeParse({ report: "overview", params: { from: "2026-09-01", to: "2026-09-30" } }).success).toBe(true);
    expect(exportRequestSchema.safeParse({ report: "payroll", params: { from: "2026-09-01", to: "2026-09-30" } }).success).toBe(false);
  });
});
