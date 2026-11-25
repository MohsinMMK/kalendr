import { describe, expect, it } from "vitest";

import { addMonthsTo, clockText, expandRuleDates, lastAllowedDate, repeatRuleSchema, ruleSummary, ruleText, type RepeatRule } from "./series-rule";

const rule = (over: Partial<RepeatRule> = {}): RepeatRule => ({ frequency: "weekly", interval: 1, weekdays: [], end: { kind: "count", count: 8 }, ...over });
const datesOf = (r: RepeatRule, startsOn: string) => expandRuleDates(r, startsOn).dates.map((entry) => entry.date);

describe("expanding a repeat rule into calendar dates", () => {
  it("makes eight Tuesdays from a Tuesday, numbered from 1", () => {
    const { dates, capped } = expandRuleDates(rule(), "2026-11-24");
    expect(dates.map((entry) => entry.date)).toEqual(["2026-11-24", "2026-12-01", "2026-12-08", "2026-12-15", "2026-12-22", "2026-12-29", "2027-01-05", "2027-01-12"]);
    expect(dates.map((entry) => entry.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(capped).toBe(false);
  });

  it("starts on the first matching day when the chosen weekday is not the first day", () => {
    expect(datesOf(rule({ weekdays: [3], end: { kind: "count", count: 3 } }), "2026-11-24")).toEqual(["2026-11-25", "2026-12-02", "2026-12-09"]);
  });

  it("does every other week and several weekdays", () => {
    expect(datesOf(rule({ interval: 2, end: { kind: "count", count: 3 } }), "2026-11-24")).toEqual(["2026-11-24", "2026-12-08", "2026-12-22"]);
    expect(datesOf(rule({ weekdays: [1, 3], end: { kind: "count", count: 5 } }), "2026-11-23")).toEqual(["2026-11-23", "2026-11-25", "2026-11-30", "2026-12-02", "2026-12-07"]);
  });

  it("does daily and every third day", () => {
    expect(datesOf(rule({ frequency: "daily", end: { kind: "count", count: 3 } }), "2026-12-30")).toEqual(["2026-12-30", "2026-12-31", "2027-01-01"]);
    expect(datesOf(rule({ frequency: "daily", interval: 3, end: { kind: "count", count: 3 } }), "2026-11-24")).toEqual(["2026-11-24", "2026-11-27", "2026-11-30"]);
  });

  it("does the same date each month and skips months that do not have it", () => {
    expect(datesOf(rule({ frequency: "monthly_date", end: { kind: "count", count: 4 } }), "2026-11-15")).toEqual(["2026-11-15", "2026-12-15", "2027-01-15", "2027-02-15"]);
    expect(datesOf(rule({ frequency: "monthly_date", end: { kind: "count", count: 3 } }), "2026-12-31")).toEqual(["2026-12-31", "2027-01-31", "2027-03-31"]);
  });

  it("does the same weekday each month: the second Tuesday, and the last one for a fifth", () => {
    // 10 Nov 2026 is the second Tuesday.
    expect(datesOf(rule({ frequency: "monthly_weekday", end: { kind: "count", count: 4 } }), "2026-11-10")).toEqual(["2026-11-10", "2026-12-08", "2027-01-12", "2027-02-09"]);
    // 29 Dec 2026 is the fifth Tuesday, so it means the last Tuesday of each month.
    expect(datesOf(rule({ frequency: "monthly_weekday", end: { kind: "count", count: 3 } }), "2026-12-29")).toEqual(["2026-12-29", "2027-01-26", "2027-02-23"]);
  });

  it("ends on a date, inclusive", () => {
    expect(datesOf(rule({ end: { kind: "until", date: "2026-12-08" } }), "2026-11-24")).toEqual(["2026-11-24", "2026-12-01", "2026-12-08"]);
  });

  it("stops at 52 visits", () => {
    const result = expandRuleDates(rule({ frequency: "daily", end: { kind: "until", date: "2027-06-01" } }), "2026-11-24");
    expect(result.dates).toHaveLength(52);
    expect(result.capped).toBe(true);
    expect(repeatRuleSchema.safeParse(rule({ end: { kind: "count", count: 53 } })).success).toBe(false);
  });

  it("stops at 12 months from the first day", () => {
    const result = expandRuleDates(rule({ frequency: "monthly_date", interval: 1, end: { kind: "count", count: 20 } }), "2026-11-15");
    expect(result.dates.at(-1)?.date).toBe("2027-10-15");
    expect(result.dates).toHaveLength(12);
    expect(result.capped).toBe(true);
    expect(lastAllowedDate("2026-11-15")).toBe("2027-11-14");
    expect(lastAllowedDate("2028-02-29")).toBe("2029-02-27");
  });

  it("works on whole dates, so a clock change cannot move a day", () => {
    // The UK clocks go back on 25 Oct 2026 and forward on 28 Mar 2027; every date is still a Sunday.
    const sundays = datesOf(rule({ end: { kind: "count", count: 8 } }), "2026-10-18");
    expect(sundays).toContain("2026-10-25");
    expect(sundays.every((date) => new Date(`${date}T00:00:00Z`).getUTCDay() === 0)).toBe(true);
  });

  it("adds months without running past the end of a short month", () => {
    expect(addMonthsTo("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsTo("2026-11-15", 12)).toBe("2027-11-15");
  });
});

describe("the rule's text and summary", () => {
  it("stores an RFC 5545 line", () => {
    expect(ruleText(rule(), "2026-11-24")).toBe("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TU;WKST=MO;COUNT=8");
    expect(ruleText(rule({ frequency: "monthly_weekday", end: { kind: "count", count: 6 } }), "2026-11-10")).toContain("BYDAY=+2TU");
  });

  it("says it the way a person would", () => {
    expect(ruleSummary(rule(), "2026-11-24", "10:00")).toBe("Every Tuesday at 10:00 am for 8 weeks");
    expect(ruleSummary(rule({ interval: 2, end: { kind: "count", count: 4 } }), "2026-11-24", "14:30")).toBe("Every 2 weeks on Tue at 2:30 pm for 4 visits");
    expect(ruleSummary(rule({ weekdays: [1, 3, 5] }), "2026-11-23", "09:00", { visit: "session", visits: "sessions" })).toBe("Every Mon, Wed and Fri at 9:00 am for 8 sessions");
    expect(ruleSummary(rule({ frequency: "daily", end: { kind: "count", count: 10 } }), "2026-11-24", "08:00")).toBe("Every day at 8:00 am for 10 days");
    expect(ruleSummary(rule({ frequency: "monthly_date", end: { kind: "count", count: 6 } }), "2026-11-02", "10:00")).toBe("Every month on the 2nd at 10:00 am for 6 months");
    expect(ruleSummary(rule({ frequency: "monthly_weekday", end: { kind: "count", count: 6 } }), "2026-11-10", "10:00")).toBe("Every month on the second Tuesday at 10:00 am for 6 months");
    expect(ruleSummary(rule({ end: { kind: "until", date: "2027-01-12" } }), "2026-11-24", "00:05")).toBe("Every Tuesday at 12:05 am, until 12 Jan 2027");
    expect(clockText("12:00")).toBe("12:00 pm");
  });

  it("rejects shapes it does not know", () => {
    expect(repeatRuleSchema.safeParse({ frequency: "hourly", interval: 1, end: { kind: "count", count: 2 } }).success).toBe(false);
    expect(repeatRuleSchema.safeParse(rule({ frequency: "monthly_date", interval: 13 })).success).toBe(false);
    expect(repeatRuleSchema.safeParse(rule({ weekdays: [8] })).success).toBe(false);
  });
});
