/** @vitest-environment node */

import { describe, expect, it } from "vitest";

import { offerableSlots } from "./offerable-slots";
import { intersect, runHoursChain, subtract, workingDays } from "./working-hours";
import type { PersonInput, ScheduleInput, ServiceRules, SlotEngineInput, Span, WorkingRule } from "./types";

const at = (iso: string): number => new Date(iso).getTime();

function schedule(timezone: string, days: Record<number, Array<[string, string]>>, overrides: ScheduleInput["overrides"] = []): ScheduleInput {
  const rules: WorkingRule[] = Object.entries(days).flatMap(([day, ranges]) =>
    ranges.map(([startsAtLocal, endsAtLocal]) => ({ dayOfWeek: Number(day), startsAtLocal, endsAtLocal, validFrom: "2025-01-01", validThrough: null })));
  return { timezone, rules, overrides };
}

const service: ServiceRules = {
  durationMinutes: 60, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minimumNoticeMinutes: 0,
  window: { kind: "rolling_days", days: 400 }, slotIntervalMinutes: 60, startOffsetMinutes: 0, requiresResource: false,
};

function person(overrides: Partial<PersonInput> & { schedule: ScheduleInput | null }): PersonInput {
  return { id: "p1", candidate: true, travel: [], outOfOffice: [], busy: [], blocks: [], ...overrides };
}

function input(overrides: Partial<SlotEngineInput> & { people: PersonInput[] }): SlotEngineInput {
  return {
    now: new Date("2026-01-01T00:00:00Z"), from: new Date("2026-12-21T00:00:00Z"), to: new Date("2026-12-22T00:00:00Z"),
    mode: "standard", timezone: "UTC", service, resources: [], holidays: [], restriction: null, ...overrides,
  };
}

const starts = (slots: ReturnType<typeof offerableSlots>): string[] => slots.map((slot) => slot.startsAt.toISOString().slice(0, 16));
const MONDAY = "2026-12-21";

describe("span helpers", () => {
  it("subtracts and intersects ranges", () => {
    expect(subtract([{ start: 0, end: 10 }], [{ start: 3, end: 5 }]).kept).toEqual([{ start: 0, end: 3 }, { start: 5, end: 10 }]);
    expect(subtract([{ start: 0, end: 10 }], [{ start: 3, end: 5 }]).removed).toEqual([{ start: 3, end: 5 }]);
    expect(intersect([{ start: 0, end: 10 }], [{ start: 5, end: 20 }])).toEqual([{ start: 5, end: 10 }]);
  });
});

describe("each step of the hours chain", () => {
  const base = person({ schedule: schedule("UTC", { 1: [["09:00", "13:00"], ["15:00", "19:00"]] }) });
  const chain = (overrides: Partial<Parameters<typeof runHoursChain>[0]> = {}) => runHoursChain({
    person: base, schedule: base.schedule!, date: MONDAY, timezone: "UTC", holidays: new Map(), restriction: null, ...overrides,
  });

  it("reads the weekly pattern with several ranges a day", () => {
    expect(chain().final).toEqual([{ start: at("2026-12-21T09:00:00Z"), end: at("2026-12-21T13:00:00Z") }, { start: at("2026-12-21T15:00:00Z"), end: at("2026-12-21T19:00:00Z") }]);
  });

  it("lets a date override replace the pattern, or close the day", () => {
    const open = schedule("UTC", { 1: [["09:00", "17:00"]] }, [{ date: MONDAY, ranges: [{ start: "10:00", end: "11:00" }] }]);
    expect(runHoursChain({ person: base, schedule: open, date: MONDAY, timezone: "UTC", holidays: new Map(), restriction: null }).final).toEqual([{ start: at("2026-12-21T10:00:00Z"), end: at("2026-12-21T11:00:00Z") }]);
    const closed = schedule("UTC", { 1: [["09:00", "17:00"]] }, [{ date: MONDAY, ranges: null }]);
    expect(runHoursChain({ person: base, schedule: closed, date: MONDAY, timezone: "UTC", holidays: new Map(), restriction: null }).final).toEqual([]);
  });

  it("closes a holiday, unless the person gave that date its own hours", () => {
    const holidays = new Map([[MONDAY, "Test Day"]]);
    expect(chain({ holidays }).final).toEqual([]);
    expect(chain({ holidays }).steps.find((step) => step.id === "holiday")?.removed[0]?.detail).toBe("Test Day");
    const worked = schedule("UTC", { 1: [["09:00", "13:00"]] }, [{ date: MONDAY, ranges: [{ start: "09:00", end: "12:00" }] }]);
    expect(runHoursChain({ person: base, schedule: worked, date: MONDAY, timezone: "UTC", holidays, restriction: null }).final).toHaveLength(1);
  });

  it("takes out time away and blocked time", () => {
    const away: Span = { start: at("2026-12-21T09:00:00Z"), end: at("2026-12-21T11:00:00Z") };
    const blocked: Span = { start: at("2026-12-21T12:00:00Z"), end: at("2026-12-21T13:00:00Z") };
    const result = chain({ person: person({ schedule: base.schedule, outOfOffice: [{ span: away, note: null }], blocks: [blocked] }) });
    expect(result.final[0]).toEqual({ start: at("2026-12-21T11:00:00Z"), end: at("2026-12-21T12:00:00Z") });
  });

  it("narrows to the restriction schedule", () => {
    const restriction = schedule("UTC", { 1: [["16:00", "18:00"]] });
    expect(chain({ restriction }).final).toEqual([{ start: at("2026-12-21T16:00:00Z"), end: at("2026-12-21T18:00:00Z") }]);
  });
});

describe("the whole chain on real cases", () => {
  it("offers nothing between 1 and 3 when the person works 9 to 1 and 3 to 7", () => {
    const slots = starts(offerableSlots(input({ people: [person({ schedule: schedule("UTC", { 1: [["09:00", "13:00"], ["15:00", "19:00"]] }) })] })));
    expect(slots).toContain("2026-12-21T12:00");
    expect(slots).not.toContain("2026-12-21T13:00");
    expect(slots).not.toContain("2026-12-21T14:00");
    expect(slots).toContain("2026-12-21T15:00");
    expect(slots).toContain("2026-12-21T18:00");
  });

  it("removes 25 December only when it is marked unavailable", () => {
    const week = schedule("UTC", { 4: [["09:00", "17:00"]], 5: [["09:00", "17:00"]] }, [{ date: "2026-12-25", ranges: null }]);
    const slots = starts(offerableSlots(input({ from: new Date("2026-12-24T00:00:00Z"), to: new Date("2026-12-26T00:00:00Z"), people: [person({ schedule: week })] })));
    expect(slots.some((slot) => slot.startsWith("2026-12-24"))).toBe(true);
    expect(slots.some((slot) => slot.startsWith("2026-12-25"))).toBe(false);
  });

  it("keeps the business open on a holiday that the owner turned off", () => {
    const week = schedule("UTC", { 7: [["09:00", "17:00"]] });
    const sunday = { from: new Date("2026-11-08T00:00:00Z"), to: new Date("2026-11-09T00:00:00Z"), now: new Date("2026-11-01T00:00:00Z") };
    expect(offerableSlots(input({ ...sunday, holidays: [{ date: "2026-11-08", name: "Deepavali" }], people: [person({ schedule: week })] }))).toHaveLength(0);
    expect(offerableSlots(input({ ...sunday, holidays: [], people: [person({ schedule: week })] })).length).toBeGreaterThan(0);
  });

  it("shifts a week of travel to Dubai by the right offset across the boundary", () => {
    const home = schedule("Asia/Kolkata", { 1: [["09:00", "17:00"]], 2: [["09:00", "17:00"]] });
    const travel = [{ from: "2026-12-22", through: "2026-12-28", timezone: "Asia/Dubai" }];
    const slots = starts(offerableSlots(input({
      from: new Date("2026-12-21T00:00:00Z"), to: new Date("2026-12-23T23:00:00Z"),
      people: [person({ schedule: home, travel })],
    })));
    // Monday 21st is still Kolkata (UTC+5:30): 09:00 is 03:30Z. Tuesday 22nd is Dubai (UTC+4): 09:00 is 05:00Z.
    expect(slots).toContain("2026-12-21T03:30");
    expect(slots).not.toContain("2026-12-22T03:30");
    expect(slots).toContain("2026-12-22T05:00");
  });

  it("offers a covering teammate only while the person is away", () => {
    const week = schedule("UTC", { 1: [["09:00", "17:00"]] });
    const away: Span = { start: at("2026-12-21T09:00:00Z"), end: at("2026-12-21T13:00:00Z") };
    const slots = offerableSlots(input({
      people: [
        person({ id: "away", schedule: week, outOfOffice: [{ span: away, note: "Back soon" }] }),
        person({ id: "cover", candidate: true, candidateWithin: [away], schedule: week }),
      ],
    }));
    expect(new Set(slots.filter((slot) => slot.startsAt.getTime() < away.end).map((slot) => slot.practitionerId))).toEqual(new Set(["cover"]));
    expect(slots.some((slot) => slot.practitionerId === "cover" && slot.startsAt.getTime() >= away.end)).toBe(false);
  });

  it("offers the overlap of the person's hours and the service's restriction", () => {
    const week = schedule("UTC", { 1: [["09:00", "17:00"]] });
    const slots = starts(offerableSlots(input({ restriction: schedule("UTC", { 1: [["14:00", "16:00"]] }), people: [person({ schedule: week })] })));
    expect(slots).toEqual(["2026-12-21T14:00", "2026-12-21T15:00"]);
  });

  it("keeps the slot grid fixed when time is blocked in the middle", () => {
    const week = schedule("UTC", { 1: [["09:00", "17:00"]] });
    const blocks: Span[] = [{ start: at("2026-12-21T12:10:00Z"), end: at("2026-12-21T12:40:00Z") }];
    const slots = starts(offerableSlots(input({ service: { ...service, durationMinutes: 30, slotIntervalMinutes: 30 }, people: [person({ schedule: week, blocks })] })));
    expect(slots).toContain("2026-12-21T13:00");
    expect(slots).not.toContain("2026-12-21T12:30");
    expect(slots).not.toContain("2026-12-21T12:40");
  });

  it("finds no days for a person with no schedule", () => {
    expect(workingDays({ holidays: [], restriction: null }, person({ schedule: null }), 0, 86_400_000 * 3)).toEqual([]);
  });
});
