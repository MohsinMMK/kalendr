import { describe, expect, it } from "vitest";

import type { SeriesPreview } from "@/lib/series-contracts";

import { bookedCount, clockIn, draftSummary, draftToRule, keepValidAnswers, noRepeat, resolutionsFrom, shownWeekdays, unresolvedCount, type RepeatDraft } from "./repeat-model";

const weekly = (over: Partial<RepeatDraft> = {}): RepeatDraft => ({ ...noRepeat, mode: "weekly", ...over });

const preview = (): SeriesPreview => ({
  timezone: "Asia/Kolkata", startsOn: "2026-11-24", timeOfDay: "10:00", ruleText: "RRULE:FREQ=WEEKLY;COUNT=3", capped: false, freeCount: 2, clashCount: 1,
  visits: [
    { index: 1, date: "2026-11-24", startsAt: "2026-11-24T04:30:00.000Z", endsAt: "2026-11-24T05:30:00.000Z", state: "free", alternatives: [] },
    { index: 2, date: "2026-12-01", startsAt: "2026-12-01T04:30:00.000Z", endsAt: "2026-12-01T05:30:00.000Z", state: "clash", reason: "already_booked", reasonLabel: "Already booked", alternatives: [{ startsAt: "2026-12-01T05:30:00.000Z", endsAt: "2026-12-01T06:30:00.000Z" }] },
    { index: 3, date: "2026-12-08", startsAt: "2026-12-08T04:30:00.000Z", endsAt: "2026-12-08T05:30:00.000Z", state: "free", alternatives: [] },
  ],
});

describe("the repeat draft", () => {
  it("makes no rule while it does not repeat", () => {
    expect(draftToRule(noRepeat, "2026-11-24")).toBeNull();
    expect(draftSummary(noRepeat, "2026-11-24", "10:00")).toBe("");
  });

  it("turns choices into a rule and says it in words", () => {
    const result = draftToRule(weekly({ count: 8 }), "2026-11-24");
    expect(result).toEqual({ rule: { frequency: "weekly", interval: 1, weekdays: [2], end: { kind: "count", count: 8 } } });
    expect(draftSummary(weekly({ count: 8 }), "2026-11-24", "10:00")).toBe("Every Tuesday at 10:00 am for 8 weeks");
    expect(draftSummary(weekly({ weekdays: [5, 1], interval: 2, count: 6 }), "2026-11-24", "14:30", { visit: "session", visits: "sessions" })).toBe("Every 2 weeks on Mon and Fri at 2:30 pm for 6 sessions");
    expect(shownWeekdays(weekly(), "2026-11-24")).toEqual([2]);
  });

  it("explains in plain words why a draft is not ready", () => {
    expect(draftToRule(weekly({ count: 1 }), "2026-11-24")).toEqual({ error: "Choose between 2 and 52 times." });
    expect(draftToRule(weekly({ count: 60 }), "2026-11-24")).toEqual({ error: "Choose between 2 and 52 times." });
    expect(draftToRule(weekly({ interval: 20 }), "2026-11-24")).toEqual({ error: "Choose between 1 and 12 weeks." });
    expect(draftToRule(weekly({ endKind: "until", until: "2026-11-20" }), "2026-11-24")).toEqual({ error: "Choose an end date after the first day." });
    expect(draftToRule(weekly({ endKind: "until", until: "2027-01-12" }), "2026-11-24")).toMatchObject({ rule: { end: { kind: "until", date: "2027-01-12" } } });
  });

  it("reads a clock time on the schedule's own clock", () => {
    expect(clockIn("2026-11-24T04:30:00.000Z")).toBe("10:00");
    expect(clockIn("2026-11-24T10:00:00.000Z", "Europe/London")).toBe("10:00");
  });
});

describe("answers to clashing visits", () => {
  it("counts what is still open and what would be booked", () => {
    const list = preview();
    expect(unresolvedCount({}, list)).toBe(1);
    expect(bookedCount({}, list)).toBe(2);
    expect(unresolvedCount({ 2: { action: "skip" } }, list)).toBe(0);
    expect(bookedCount({ 2: { action: "skip" } }, list)).toBe(2);
    expect(bookedCount({ 2: { action: "move", startsAt: "2026-12-01T05:30:00.000Z" } }, list)).toBe(3);
  });

  it("sends only answers for visits that clash", () => {
    expect(resolutionsFrom({ 1: { action: "skip" }, 2: { action: "move", startsAt: "2026-12-01T05:30:00.000Z" } }, preview())).toEqual([{ index: 2, action: "move", startsAt: "2026-12-01T05:30:00.000Z" }]);
  });

  it("keeps answers that still apply when the list is checked again, and drops the rest", () => {
    const list = preview();
    expect(keepValidAnswers({ 2: { action: "move", startsAt: "2026-12-01T05:30:00.000Z" } }, list)).toEqual({ 2: { action: "move", startsAt: "2026-12-01T05:30:00.000Z" } });
    expect(keepValidAnswers({ 2: { action: "move", startsAt: "2026-12-01T09:00:00.000Z" } }, list)).toEqual({});
    expect(keepValidAnswers({ 1: { action: "skip" } }, list)).toEqual({});
    expect(keepValidAnswers({ 2: { action: "skip" } }, list)).toEqual({ 2: { action: "skip" } });
  });
});
