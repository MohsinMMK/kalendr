import { describe, expect, it } from "vitest";

import {
  addDaysToKey,
  addMonthsToKey,
  dayStartUtc,
  formatClock,
  mergeIntervals,
  missingRange,
  slotAccessibleName,
  splitRange,
  startOfWeekKey,
  todayKey,
  visitorFullDays,
} from "./zone-time";

const DAY = 86_400_000;

describe("days in a zone", () => {
  it("finds where a day begins, including across a daylight saving change", () => {
    expect(dayStartUtc("2026-12-03", "Asia/Kolkata").toISOString()).toBe("2026-12-02T18:30:00.000Z");
    expect(dayStartUtc("2026-12-03", "Asia/Kathmandu").toISOString()).toBe("2026-12-02T18:15:00.000Z");
    expect(dayStartUtc("2026-03-08", "America/New_York").toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(dayStartUtc("2026-03-09", "America/New_York").toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  it("decides today in the shown zone, not the browser's", () => {
    const instant = new Date("2026-12-03T20:00:00Z");
    expect(todayKey("Asia/Kolkata", instant)).toBe("2026-12-04");
    expect(todayKey("Asia/Dubai", instant)).toBe("2026-12-04");
    expect(todayKey("America/New_York", instant)).toBe("2026-12-03");
  });

  it("starts weeks on Monday or Sunday and moves by days and months on keys", () => {
    expect(startOfWeekKey("2026-12-03", 1)).toBe("2026-11-30");
    expect(startOfWeekKey("2026-12-03", 0)).toBe("2026-11-29");
    expect(startOfWeekKey("2026-11-30", 1)).toBe("2026-11-30");
    expect(addDaysToKey("2026-12-30", 3)).toBe("2027-01-02");
    expect(addMonthsToKey("2026-12-15", 1)).toBe("2027-01-01");
  });
});

describe("clock and names", () => {
  it("writes the same instant on a 12 or 24 hour clock in the chosen zone", () => {
    expect(formatClock("2026-12-03T07:30:00Z", "en-IN", "Asia/Kolkata", true)).toMatch(/^1:00\s?pm$/i);
    expect(formatClock("2026-12-03T07:30:00Z", "en-IN", "Asia/Kolkata", false)).toBe("13:00");
    expect(formatClock("2026-12-03T07:30:00Z", "en-IN", "Asia/Dubai", false)).toBe("11:30");
  });

  it("names a time with its whole date, the time and the person", () => {
    const name = slotAccessibleName({ startsAt: "2026-12-03T05:00:00Z", locale: "en-GB", zone: "Asia/Kolkata", hour12: true, person: "Dr Rao" });
    expect(name).toMatch(/^Thursday,? 3 December, 10:30\s?am, Dr Rao$/i);
  });
});

describe("loading ranges", () => {
  it("asks only for what is missing and returns nothing when everything is loaded", () => {
    expect(missingRange({ from: 0, to: 10 * DAY }, [{ from: 0, to: 14 * DAY }])).toBeNull();
    expect(missingRange({ from: 10 * DAY, to: 40 * DAY }, [{ from: 0, to: 14 * DAY }])).toEqual({ from: 14 * DAY, to: 40 * DAY });
    expect(missingRange({ from: 0, to: 30 * DAY }, [{ from: 5 * DAY, to: 10 * DAY }])).toEqual({ from: 0, to: 30 * DAY });
    expect(missingRange({ from: 0, to: 5 * DAY }, [])).toEqual({ from: 0, to: 5 * DAY });
  });

  it("merges touching intervals and cuts a range into two-week windows", () => {
    expect(mergeIntervals([{ from: 5, to: 8 }, { from: 0, to: 5 }, { from: 20, to: 30 }])).toEqual([{ from: 0, to: 8 }, { from: 20, to: 30 }]);
    expect(splitRange({ from: 0, to: 31 * DAY })).toEqual([
      { from: 0, to: 14 * DAY },
      { from: 14 * DAY, to: 28 * DAY },
      { from: 28 * DAY, to: 31 * DAY },
    ]);
  });
});

describe("full days seen from another zone", () => {
  const base = { businessZone: "Asia/Kolkata" };

  it("is the business's own list when the zones agree, leaving out days that have openings", () => {
    expect(visitorFullDays({ ...base, displayZone: "Asia/Kolkata", fullDays: ["2026-12-03", "2026-12-04"], openDayKeys: new Set(["2026-12-04"]) })).toEqual(["2026-12-03"]);
  });

  it("does not cross out a day that straddles a full business day and an open one", () => {
    // Kolkata 3 December is 2 December 22:30 to 3 December 22:30 in Dubai: no Dubai day is covered by it alone.
    expect(visitorFullDays({ ...base, displayZone: "Asia/Dubai", fullDays: ["2026-12-03"], openDayKeys: new Set() })).toEqual([]);
  });

  it("crosses out a day only when every business day it touches is full", () => {
    const result = visitorFullDays({ ...base, displayZone: "Asia/Dubai", fullDays: ["2026-12-02", "2026-12-03", "2026-12-04"], openDayKeys: new Set() });
    expect(result).toEqual(["2026-12-02", "2026-12-03"]);
  });

  it("copes with a quarter-hour offset and never crosses out a day with openings", () => {
    const full = ["2026-12-02", "2026-12-03", "2026-12-04"];
    expect(visitorFullDays({ ...base, displayZone: "Asia/Kathmandu", fullDays: full, openDayKeys: new Set() })).toEqual(["2026-12-03", "2026-12-04"]);
    expect(visitorFullDays({ ...base, displayZone: "Asia/Kathmandu", fullDays: full, openDayKeys: new Set(["2026-12-03"]) })).toEqual(["2026-12-04"]);
  });
});
