import { describe, expect, it } from "vitest";

import { clockText, insideWindow, localParts, parseClock, quietUntil } from "./quiet-hours";

const IST = "Asia/Kolkata";

describe("quiet hours", () => {
  it("reads and writes clock times", () => {
    expect(parseClock("07:30")).toBe(450);
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("7:30")).toBeNull();
    expect(clockText(450)).toBe("07:30");
    expect(clockText(0)).toBe("00:00");
  });

  it("finds the local minute and day in the business's time zone", () => {
    expect(localParts(new Date("2026-11-20T20:00:00Z"), IST)).toEqual({ minute: 60 + 30, day: "2026-11-21" });
    expect(localParts(new Date("2026-11-20T04:00:00Z"), IST)).toEqual({ minute: 9 * 60 + 30, day: "2026-11-20" });
  });

  it("knows a window that runs past midnight", () => {
    expect(insideWindow(23 * 60, 22 * 60, 7 * 60)).toBe(true);
    expect(insideWindow(3 * 60, 22 * 60, 7 * 60)).toBe(true);
    expect(insideWindow(12 * 60, 22 * 60, 7 * 60)).toBe(false);
    expect(insideWindow(10 * 60, 9 * 60, 17 * 60)).toBe(true);
    expect(insideWindow(17 * 60, 9 * 60, 17 * 60)).toBe(false);
  });

  it("lets push and email go at once outside quiet hours, and none set means always", () => {
    const noon = new Date("2026-11-20T06:30:00Z");
    expect(quietUntil(noon, IST, 22 * 60, 7 * 60)).toBeNull();
    expect(quietUntil(noon, IST, null, null)).toBeNull();
    expect(quietUntil(noon, IST, 600, 600)).toBeNull();
  });

  it("holds them until quiet hours end, even across midnight", () => {
    // 23:30 in Kolkata, quiet 22:00 to 07:00: they may go at 07:00 the next morning.
    const night = new Date("2026-11-20T18:00:00Z");
    expect(quietUntil(night, IST, 22 * 60, 7 * 60)?.toISOString()).toBe("2026-11-21T01:30:00.000Z");
    // 03:00 the same night: they may go at 07:00 the same morning.
    const small = new Date("2026-11-20T21:30:00Z");
    expect(quietUntil(small, IST, 22 * 60, 7 * 60)?.toISOString()).toBe("2026-11-21T01:30:00.000Z");
  });

  it("holds to the end of a daytime window", () => {
    const lunch = new Date("2026-11-20T07:00:00Z");
    expect(quietUntil(lunch, IST, 12 * 60, 14 * 60)?.toISOString()).toBe("2026-11-20T08:30:00.000Z");
  });
});
