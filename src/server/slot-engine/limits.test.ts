/** @vitest-environment node */

import { describe, expect, it } from "vitest";

import { keepFirstPerDay, periodBounds } from "./limits";
import { analyseSlots, offerableSlots } from "./offerable-slots";
import type { LimitRuleInput, LimitUsageInput, PersonInput, ServiceRules, SlotEngineInput, WorkingRule } from "./types";

const allDays = [1, 2, 3, 4, 5, 6, 7];
function hours(timezone: string) {
  const rules: WorkingRule[] = allDays.map((dayOfWeek) => ({ dayOfWeek, startsAtLocal: "09:00", endsAtLocal: "17:00", validFrom: "2025-01-01", validThrough: null }));
  return { timezone, rules, overrides: [] };
}
const service: ServiceRules = {
  durationMinutes: 60, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minimumNoticeMinutes: 0,
  window: { kind: "rolling_days", days: 365 }, slotIntervalMinutes: 60, startOffsetMinutes: 0, requiresResource: false,
};
function person(id: string, timezone = "UTC"): PersonInput {
  return { id, candidate: true, schedule: hours(timezone), travel: [], outOfOffice: [], busy: [], blocks: [] };
}
function build(overrides: Partial<SlotEngineInput>): SlotEngineInput {
  return {
    now: new Date("2026-01-01T00:00:00Z"), from: new Date("2026-01-05T00:00:00Z"), to: new Date("2026-01-07T00:00:00Z"),
    mode: "standard", timezone: "UTC", service, people: [person("p1")], resources: [], holidays: [], restriction: null,
    serviceId: "s1", locationId: "l1", ...overrides,
  };
}
const rule = (overrides: Partial<LimitRuleInput>): LimitRuleInput => ({
  id: "r1", scope: "service", scopeId: "s1", memberIds: [], measure: "count", period: "day", maxValue: 3, weekStart: 1, ...overrides,
});
const usage = (ruleId: string, days: Array<[string, number, number?]>): LimitUsageInput => ({
  ruleId, days: days.map(([date, count, minutes]) => ({ date, count, minutes: minutes ?? count * 60 })),
});

describe("periodBounds", () => {
  it("finds the week from either week start, the month and the year", () => {
    expect(periodBounds("2026-01-07", "week", 1)).toEqual({ first: "2026-01-05", last: "2026-01-11" });
    expect(periodBounds("2026-01-11", "week", 1)).toEqual({ first: "2026-01-05", last: "2026-01-11" });
    expect(periodBounds("2026-01-07", "week", 7)).toEqual({ first: "2026-01-04", last: "2026-01-10" });
    expect(periodBounds("2026-01-04", "week", 7)).toEqual({ first: "2026-01-04", last: "2026-01-10" });
    expect(periodBounds("2026-02-10", "month", 1)).toEqual({ first: "2026-02-01", last: "2026-02-28" });
    expect(periodBounds("2028-12-31", "month", 1)).toEqual({ first: "2028-12-01", last: "2028-12-31" });
    expect(periodBounds("2026-06-30", "year", 1)).toEqual({ first: "2026-01-01", last: "2026-12-31" });
  });
});

describe("booking limits in the slot engine", () => {
  it("stops offering a day once its daily limit is used, and says the day is full", () => {
    const analysis = analyseSlots(build({ limits: [rule({})], usage: [usage("r1", [["2026-01-05", 3]])] }));
    const days = new Set(analysis.slots.map((slot) => slot.startsAt.toISOString().slice(0, 10)));
    expect(days).toEqual(new Set(["2026-01-06"]));
    expect(analysis.fullDays).toEqual(["2026-01-05"]);
  });

  it("still offers the day when one place is left", () => {
    const slots = offerableSlots(build({ limits: [rule({})], usage: [usage("r1", [["2026-01-05", 2]])] }));
    expect(slots.some((slot) => slot.startsAt.toISOString().startsWith("2026-01-05"))).toBe(true);
  });

  it("counts a person's limit across all their services but not another person's", () => {
    const limits = [rule({ id: "r2", scope: "practitioner", scopeId: "p1", maxValue: 20 })];
    const full = usage("r2", [["2026-01-05", 20]]);
    const slots = offerableSlots(build({ limits, usage: [full], people: [person("p1"), person("p2")] }));
    expect(slots.filter((slot) => slot.startsAt.toISOString().startsWith("2026-01-05")).every((slot) => slot.practitionerId === "p2")).toBe(true);
    expect(slots.some((slot) => slot.practitionerId === "p1" && slot.startsAt.toISOString().startsWith("2026-01-06"))).toBe(true);
  });

  it("limits a hand-picked team together", () => {
    const limits = [rule({ id: "r3", scope: "team", scopeId: "t1", memberIds: ["p1", "p2"], maxValue: 5 })];
    const slots = offerableSlots(build({ limits, usage: [usage("r3", [["2026-01-05", 5]])], people: [person("p1"), person("p2"), person("p3")] }));
    const onFirst = slots.filter((slot) => slot.startsAt.toISOString().startsWith("2026-01-05"));
    expect(new Set(onFirst.map((slot) => slot.practitionerId))).toEqual(new Set(["p3"]));
  });

  it("limits booked minutes, counting the new visit's own length", () => {
    const limits = [rule({ measure: "minutes", maxValue: 240 })];
    const slots = offerableSlots(build({ limits, usage: [usage("r1", [["2026-01-05", 3, 200]])] }));
    // 200 + 60 > 240, so Monday is closed to a one-hour visit; a 30-minute one would still fit.
    expect(slots.some((slot) => slot.startsAt.toISOString().startsWith("2026-01-05"))).toBe(false);
    const shorter = offerableSlots(build({ limits, usage: [usage("r1", [["2026-01-05", 3, 200]])], service: { ...service, durationMinutes: 30, slotIntervalMinutes: 30 } }));
    expect(shorter.some((slot) => slot.startsAt.toISOString().startsWith("2026-01-05"))).toBe(true);
  });

  it("closes the whole week when a weekly limit is reached, using the business's timezone", () => {
    const limits = [rule({ period: "week", maxValue: 10 })];
    const slots = offerableSlots(build({
      limits, usage: [usage("r1", [["2026-01-05", 4], ["2026-01-06", 6]])],
      from: new Date("2026-01-05T00:00:00Z"), to: new Date("2026-01-13T00:00:00Z"),
    }));
    const days = new Set(slots.map((slot) => slot.startsAt.toISOString().slice(0, 10)));
    expect([...days].some((day) => day <= "2026-01-11")).toBe(false);
    expect(days.has("2026-01-12")).toBe(true);
  });

  it("reads a day on the business's clock: Auckland's Tuesday morning is Monday in UTC", () => {
    const limits = [rule({ maxValue: 1 })];
    const slots = offerableSlots(build({
      timezone: "Pacific/Auckland", people: [person("p1", "Pacific/Auckland")], limits,
      usage: [usage("r1", [["2026-01-06", 1]])], now: new Date("2026-01-01T00:00:00Z"),
      from: new Date("2026-01-05T11:00:00Z"), to: new Date("2026-01-06T11:00:00Z"),
    }));
    // The whole local Tuesday (from 2026-01-05T11:00Z) is the full day.
    expect(slots).toHaveLength(0);
  });

  it("skips limits entirely when staff override them", () => {
    // The loader leaves limits out for an override; the engine given no limits offers every start.
    expect(offerableSlots(build({ limits: [], usage: [] })).length).toBeGreaterThan(0);
  });

  it("offers each person only their earliest free time of the day with first slot only", () => {
    const slots = offerableSlots(build({ service: { ...service, firstSlotOnly: true }, people: [person("p1"), person("p2")] }));
    expect(slots).toHaveLength(4);
    expect(slots.filter((slot) => slot.practitionerId === "p1").map((slot) => slot.startsAt.toISOString())).toEqual(["2026-01-05T09:00:00.000Z", "2026-01-06T09:00:00.000Z"]);
  });

  it("keepFirstPerDay keeps one start per person per local day", () => {
    const slots = [
      { practitionerId: "a", startsAt: new Date("2026-01-05T10:00:00Z") },
      { practitionerId: "a", startsAt: new Date("2026-01-05T09:00:00Z") },
      { practitionerId: "b", startsAt: new Date("2026-01-05T11:00:00Z") },
    ];
    expect(keepFirstPerDay(slots, "UTC").map((slot) => `${slot.practitionerId}${slot.startsAt.getUTCHours()}`)).toEqual(["a9", "b11"]);
  });

  it("applies a room's own limit by moving to another room, then refusing when every room is full", () => {
    const rooms = [{ id: "room1", busy: [] }, { id: "room2", busy: [] }];
    const limits = [rule({ id: "r4", scope: "resource", scopeId: "room1", maxValue: 1 })];
    const withRooms = build({ service: { ...service, requiresResource: true }, resources: rooms, limits, usage: [usage("r4", [["2026-01-05", 1]])] });
    const first = offerableSlots(withRooms).find((slot) => slot.startsAt.toISOString().startsWith("2026-01-05"));
    expect(first?.resourceId).toBe("room2");
    const both = build({ service: { ...service, requiresResource: true }, resources: [rooms[0]!], limits, usage: [usage("r4", [["2026-01-05", 1]])] });
    expect(offerableSlots(both).some((slot) => slot.startsAt.toISOString().startsWith("2026-01-05"))).toBe(false);
  });
});
