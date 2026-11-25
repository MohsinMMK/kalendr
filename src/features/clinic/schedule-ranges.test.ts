import { describe, expect, it } from "vitest";

import { addRange, convertRange, copyDay, dayIssue, emptyWeek, nextRange, removeRange, summariseDay, workWeekdays } from "./schedule-ranges";

describe("weekly ranges", () => {
  it("adds a second range after the first and removes one", () => {
    let week = addRange(emptyWeek, "1");
    expect(week["1"]).toEqual([{ start: "09:00", end: "17:00" }]);
    week = { ...week, "1": [{ start: "09:00", end: "13:00" }] };
    week = addRange(week, "1");
    expect(week["1"][1]).toEqual({ start: "13:30", end: "14:30" });
    expect(removeRange(week, "1", 0)["1"]).toEqual([{ start: "13:30", end: "14:30" }]);
    expect(nextRange([{ start: "20:00", end: "23:00" }]).end <= "24:00").toBe(true);
  });

  it("flags overlapping and backwards ranges", () => {
    expect(dayIssue([{ start: "09:00", end: "13:00" }, { start: "12:00", end: "15:00" }])).toMatch(/overlap/);
    expect(dayIssue([{ start: "09:00", end: "13:00" }, { start: "15:00", end: "19:00" }])).toBeNull();
    expect(dayIssue([{ start: "13:00", end: "09:00" }])).toMatch(/end after/);
  });

  it("copies one day to the weekdays without touching the source", () => {
    const week = { ...emptyWeek, "1": [{ start: "09:00", end: "13:00" }, { start: "15:00", end: "19:00" }] };
    const copied = copyDay(week, "1", workWeekdays);
    expect(copied["5"]).toEqual(week["1"]);
    expect(copied["6"]).toEqual([]);
    expect(summariseDay(copied["3"])).toBe("09:00–13:00, 15:00–19:00");
  });

  it("converts a traveller's hours to home time", () => {
    // 9:00–17:00 in Dubai (UTC+4) is 10:30–18:30 in India (UTC+5:30).
    expect(convertRange({ start: "09:00", end: "17:00" }, "Asia/Dubai", "Asia/Kolkata")).toEqual({ start: "10:30", end: "18:30" });
  });
});
