/** @vitest-environment node */

import { describe, expect, it } from "vitest";

import type { WeeklyHours } from "@/lib/availability-setup";

import { instantsToWholeDays, overlappingDays, rowsToWeekly, weeklyToRows, wholeDaysToInstants } from "./availability-mapping";

const empty: WeeklyHours = { "1": [], "2": [], "3": [], "4": [], "5": [], "6": [], "7": [] };

describe("weekly pattern and rule rows", () => {
  it("round-trips several ranges a day", () => {
    const weekly: WeeklyHours = { ...empty, "1": [{ start: "15:00", end: "19:00" }, { start: "09:00", end: "13:00" }], "6": [{ start: "10:00", end: "24:00" }] };
    const rows = weeklyToRows(weekly);
    expect(rows).toEqual([
      { dayOfWeek: 1, startsAtLocal: "09:00:00", endsAtLocal: "13:00:00" },
      { dayOfWeek: 1, startsAtLocal: "15:00:00", endsAtLocal: "19:00:00" },
      { dayOfWeek: 6, startsAtLocal: "10:00:00", endsAtLocal: "24:00:00" },
    ]);
    expect(rowsToWeekly(rows)).toEqual({ ...empty, "1": [{ start: "09:00", end: "13:00" }, { start: "15:00", end: "19:00" }], "6": [{ start: "10:00", end: "24:00" }] });
  });

  it("collapses the same range stored for two branches", () => {
    const row = { dayOfWeek: 2, startsAtLocal: "09:00:00", endsAtLocal: "17:00:00" };
    expect(rowsToWeekly([row, row])["2"]).toEqual([{ start: "09:00", end: "17:00" }]);
  });

  it("finds overlapping days", () => {
    expect(overlappingDays({ ...empty, "3": [{ start: "09:00", end: "12:00" }, { start: "11:00", end: "14:00" }] })).toEqual(["3"]);
    expect(overlappingDays({ ...empty, "3": [{ start: "09:00", end: "12:00" }, { start: "12:00", end: "14:00" }] })).toEqual([]);
  });
});

describe("whole days to instants", () => {
  it("spans local midnights and survives a clock change", () => {
    const plain = wholeDaysToInstants("2026-12-24", "2026-12-26", "Asia/Kolkata");
    expect(plain.startsAt.toISOString()).toBe("2026-12-23T18:30:00.000Z");
    expect(plain.endsAt.toISOString()).toBe("2026-12-26T18:30:00.000Z");
    // London springs forward on 29 March 2026: that day is 23 hours long.
    const london = wholeDaysToInstants("2026-03-29", "2026-03-29", "Europe/London");
    expect(london.endsAt.getTime() - london.startsAt.getTime()).toBe(23 * 3_600_000);
    expect(instantsToWholeDays(london.startsAt, london.endsAt, "Europe/London")).toEqual({ startsOn: "2026-03-29", throughDate: "2026-03-29" });
    expect(instantsToWholeDays(plain.startsAt, plain.endsAt, "Asia/Kolkata")).toEqual({ startsOn: "2026-12-24", throughDate: "2026-12-26" });
  });
});
