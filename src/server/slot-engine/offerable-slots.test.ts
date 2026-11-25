/** @vitest-environment node */

import { describe, expect, it } from "vitest";

import { offerableSlots } from "./offerable-slots";
import { isBeyondWindow } from "./service-rules";
import type { PersonInput, ScheduleInput, ServiceRules, SlotEngineInput, Span, WorkingRule } from "./types";

const weekdays = [1, 2, 3, 4, 5];
const allDays = [1, 2, 3, 4, 5, 6, 7];

function hours(days: number[], timezone: string, start = "09:00", end = "17:00"): ScheduleInput {
  const rules: WorkingRule[] = days.map((dayOfWeek) => ({ dayOfWeek, startsAtLocal: start, endsAtLocal: end, validFrom: "2025-01-01", validThrough: null }));
  return { timezone, rules, overrides: [] };
}

const baseService: ServiceRules = {
  durationMinutes: 60,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minimumNoticeMinutes: 0,
  window: { kind: "rolling_days", days: 365 },
  slotIntervalMinutes: 60,
  startOffsetMinutes: 0,
  requiresResource: false,
};

function person(overrides: Partial<PersonInput> & { schedule: ScheduleInput }): PersonInput {
  return { id: "p1", candidate: true, travel: [], outOfOffice: [], busy: [], blocks: [], ...overrides };
}

function input(overrides: Partial<SlotEngineInput> & { people: PersonInput[] }): SlotEngineInput {
  return {
    now: new Date("2026-01-01T00:00:00Z"),
    from: new Date("2026-01-05T00:00:00Z"),
    to: new Date("2026-01-06T00:00:00Z"),
    mode: "standard",
    timezone: "UTC",
    service: baseService,
    resources: [],
    holidays: [],
    restriction: null,
    ...overrides,
  };
}

const starts = (slots: ReturnType<typeof offerableSlots>): string[] => slots.map((slot) => slot.startsAt.toISOString());
const at = (iso: string): number => new Date(iso).getTime();

describe("offerableSlots", () => {
  it("offers every grid start inside the working range, last one ending at closing", () => {
    const slots = offerableSlots(input({ people: [person({ schedule: hours(allDays, "UTC") })] }));
    expect(starts(slots)[0]).toBe("2026-01-05T09:00:00.000Z");
    expect(starts(slots).at(-1)).toBe("2026-01-05T16:00:00.000Z");
    expect(slots).toHaveLength(8);
  });

  it("keeps wall-clock times across a daylight-saving change in Europe/London", () => {
    const slots = offerableSlots(input({
      from: new Date("2026-03-28T00:00:00Z"),
      to: new Date("2026-03-30T23:59:00Z"),
      now: new Date("2026-03-01T00:00:00Z"),
      timezone: "Europe/London",
      people: [person({ schedule: hours(allDays, "Europe/London") })],
    }));
    const byDay = (day: string) => starts(slots).filter((start) => start.startsWith(day));
    // Saturday 28 March is still GMT: 09:00 local is 09:00 UTC.
    expect(byDay("2026-03-28")[0]).toBe("2026-03-28T09:00:00.000Z");
    // The clocks go forward on Sunday 29 March: 09:00 local is now 08:00 UTC, and the day is still eight slots.
    expect(byDay("2026-03-29")[0]).toBe("2026-03-29T08:00:00.000Z");
    expect(byDay("2026-03-29")).toHaveLength(8);
    expect(byDay("2026-03-30")[0]).toBe("2026-03-30T08:00:00.000Z");
  });

  it("blocks a start whose buffer would touch another booking, on both sides", () => {
    // An existing 10:00 to 10:30 visit that already carries its own 10 minute after-buffer.
    const busy: Span[] = [{ start: at("2026-01-05T10:00:00Z"), end: at("2026-01-05T10:40:00Z") }];
    const service = { ...baseService, durationMinutes: 30, slotIntervalMinutes: 15, bufferAfterMinutes: 10 };
    const slots = starts(offerableSlots(input({ service, people: [person({ schedule: hours(allDays, "UTC"), busy })] })));
    // 09:30 to 10:00 plus its 10 minute buffer runs to 10:10 and would sit on the booking.
    expect(slots).not.toContain("2026-01-05T09:30:00.000Z");
    expect(slots).toContain("2026-01-05T09:15:00.000Z");
    // The existing booking's buffer ends at 10:40, so 10:30 is taken and 10:45 is free.
    expect(slots).not.toContain("2026-01-05T10:30:00.000Z");
    expect(slots).toContain("2026-01-05T10:45:00.000Z");
  });

  it("keeps the visit and both buffers inside working hours", () => {
    const service = { ...baseService, durationMinutes: 30, slotIntervalMinutes: 15, bufferBeforeMinutes: 5, bufferAfterMinutes: 10 };
    const slots = starts(offerableSlots(input({ service, people: [person({ schedule: hours(allDays, "UTC") })] })));
    expect(slots[0]).toBe("2026-01-05T09:15:00.000Z");
    expect(slots.at(-1)).toBe("2026-01-05T16:15:00.000Z");
  });

  it("refuses starts inside the minimum notice", () => {
    const service = { ...baseService, minimumNoticeMinutes: 24 * 60 };
    const slots = offerableSlots(input({
      now: new Date("2026-01-04T12:00:00Z"),
      from: new Date("2026-01-05T00:00:00Z"),
      to: new Date("2026-01-06T23:00:00Z"),
      service,
      people: [person({ schedule: hours(allDays, "UTC") })],
    }));
    expect(starts(slots)[0]).toBe("2026-01-05T12:00:00.000Z");
  });

  it("stops at the rolling booking window", () => {
    const service = { ...baseService, window: { kind: "rolling_days" as const, days: 30 } };
    const slots = offerableSlots(input({
      now: new Date("2026-01-01T09:30:00Z"),
      from: new Date("2026-01-30T00:00:00Z"),
      to: new Date("2026-02-03T00:00:00Z"),
      service,
      people: [person({ schedule: hours(allDays, "UTC") })],
    }));
    expect(starts(slots).at(-1)).toBe("2026-01-31T09:00:00.000Z");
  });

  it("counts business days and skips a closed weekend", () => {
    const service = { ...baseService, window: { kind: "business_days" as const, days: 2 } };
    // Thursday 4 June. The next two open days are Friday 5 and Monday 8.
    const slots = offerableSlots(input({
      now: new Date("2026-06-04T08:00:00Z"),
      from: new Date("2026-06-04T09:00:00Z"),
      to: new Date("2026-06-12T00:00:00Z"),
      timezone: "UTC",
      service,
      people: [person({ schedule: hours(weekdays, "UTC") })],
    }));
    const days = [...new Set(starts(slots).map((start) => start.slice(0, 10)))];
    expect(days).toEqual(["2026-06-04", "2026-06-05", "2026-06-08"]);
  });

  it("keeps a date-range window to its dates", () => {
    expect(isBeyondWindow(at("2026-06-10T10:00:00Z"), at("2026-06-01T00:00:00Z"), { kind: "date_range", from: "2026-06-08", through: "2026-06-12" }, "UTC", [])).toBe(false);
    expect(isBeyondWindow(at("2026-06-13T10:00:00Z"), at("2026-06-01T00:00:00Z"), { kind: "date_range", from: "2026-06-08", through: "2026-06-12" }, "UTC", [])).toBe(true);
    expect(isBeyondWindow(at("2026-06-07T10:00:00Z"), at("2026-06-01T00:00:00Z"), { kind: "date_range", from: "2026-06-08", through: "2026-06-12" }, "UTC", [])).toBe(true);
  });

  it("starts slots at the offset and spaces them by the interval, or by the length when none is set", () => {
    const offset = offerableSlots(input({ service: { ...baseService, durationMinutes: 30, slotIntervalMinutes: 30, startOffsetMinutes: 5 }, people: [person({ schedule: hours(allDays, "UTC") })] }));
    expect(starts(offset).slice(0, 2)).toEqual(["2026-01-05T09:05:00.000Z", "2026-01-05T09:35:00.000Z"]);
    const sameAsLength = offerableSlots(input({ service: { ...baseService, durationMinutes: 45, slotIntervalMinutes: null }, people: [person({ schedule: hours(allDays, "UTC") })] }));
    expect(starts(sameAsLength).slice(0, 3)).toEqual(["2026-01-05T09:00:00.000Z", "2026-01-05T09:45:00.000Z", "2026-01-05T10:30:00.000Z"]);
  });

  it("offers different slots for different lengths", () => {
    const run = (durationMinutes: number) => starts(offerableSlots(input({ service: { ...baseService, durationMinutes, slotIntervalMinutes: 15 }, people: [person({ schedule: hours(allDays, "UTC") })] })));
    const thirty = run(30);
    const sixty = run(60);
    expect(thirty.at(-1)).toBe("2026-01-05T16:30:00.000Z");
    expect(sixty.at(-1)).toBe("2026-01-05T16:00:00.000Z");
    expect(thirty.length).toBeGreaterThan(sixty.length);
  });

  it("applies a block that closes the whole team or one person", () => {
    const blocks: Span[] = [{ start: at("2026-01-05T12:00:00Z"), end: at("2026-01-05T13:00:00Z") }];
    const slots = starts(offerableSlots(input({ people: [person({ schedule: hours(allDays, "UTC"), blocks })] })));
    expect(slots).not.toContain("2026-01-05T12:00:00.000Z");
    expect(slots).toContain("2026-01-05T11:00:00.000Z");
    expect(slots).toContain("2026-01-05T13:00:00.000Z");
  });

  it("needs a free resource when the service requires one and names the one it picked", () => {
    const service = { ...baseService, requiresResource: true };
    const busy: Span = { start: at("2026-01-05T09:00:00Z"), end: at("2026-01-05T10:00:00Z") };
    const slots = offerableSlots(input({
      service,
      people: [person({ schedule: hours(allDays, "UTC") })],
      resources: [{ id: "chair-a", busy: [busy] }, { id: "chair-b", busy: [] }],
    }));
    expect(slots[0]?.resourceId).toBe("chair-b");
    expect(slots.find((slot) => slot.startsAt.toISOString() === "2026-01-05T10:00:00.000Z")?.resourceId).toBe("chair-a");
    const none = offerableSlots(input({ service, people: [person({ schedule: hours(allDays, "UTC") })], resources: [] }));
    expect(none).toEqual([]);
  });

  it("ignores notice and window for someone who is here now, but only offers the next 12 hours", () => {
    const now = new Date("2026-01-05T10:07:00Z");
    const slots = offerableSlots(input({
      now,
      from: new Date("2026-01-05T00:00:00Z"),
      to: new Date("2026-01-06T00:00:00Z"),
      mode: "walk_in",
      service: { ...baseService, minimumNoticeMinutes: 24 * 60, slotIntervalMinutes: 15, durationMinutes: 15 },
      people: [person({ schedule: hours(allDays, "UTC") })],
    }));
    expect(starts(slots)[0]).toBe("2026-01-05T10:00:00.000Z");
    expect(starts(slots).at(-1)).toBe("2026-01-05T16:45:00.000Z");
  });

  it("counts teammates who are not candidates when working out open days only", () => {
    const service = { ...baseService, window: { kind: "business_days" as const, days: 1 } };
    const slots = offerableSlots(input({
      now: new Date("2026-06-05T08:00:00Z"),
      from: new Date("2026-06-05T00:00:00Z"),
      to: new Date("2026-06-12T00:00:00Z"),
      service,
      people: [
        person({ id: "me", schedule: hours([5], "UTC") }),
        person({ id: "other", candidate: false, schedule: hours([1], "UTC") }),
      ],
    }));
    // Friday is today. The next open day is Monday, so Monday is the last allowed date, but "me" does not work it.
    expect(new Set(slots.map((slot) => slot.practitionerId))).toEqual(new Set(["me"]));
    expect(starts(slots).every((start) => start.startsWith("2026-06-05"))).toBe(true);
  });
  describe("busy time in a connected calendar (feature 16)", () => {
    const busy: Span = { start: at("2026-01-05T10:00:00Z"), end: at("2026-01-05T11:00:00Z") };
    const limit = { id: "l1", scope: "service" as const, scopeId: "svc", memberIds: [], measure: "count" as const, period: "day" as const, maxValue: 5, weekStart: 1 as const };

    it("removes the starts that overlap it", () => {
      const slots = offerableSlots(input({ people: [person({ schedule: hours(weekdays, "UTC"), calendarBusy: [busy] })] }));
      expect(starts(slots)).not.toContain("2026-01-05T10:00:00.000Z");
      expect(starts(slots)).toContain("2026-01-05T09:00:00.000Z");
      expect(starts(slots)).toContain("2026-01-05T11:00:00.000Z");
    });

    it("still applies when booking limits are in force, so the booking commit refuses it too", () => {
      const slots = offerableSlots(input({
        serviceId: "svc", locationId: "loc", limits: [limit], usage: [],
        people: [person({ schedule: hours(weekdays, "UTC"), calendarBusy: [busy] })],
      }));
      expect(starts(slots)).not.toContain("2026-01-05T10:00:00.000Z");
      expect(starts(slots).length).toBeGreaterThan(0);
    });

    it("hides the busy first slot, so first-slot-only offers the next free start instead", () => {
      const slots = offerableSlots(input({
        service: { ...baseService, firstSlotOnly: true },
        people: [person({ schedule: hours(weekdays, "UTC", "10:00", "13:00"), calendarBusy: [busy] })],
      }));
      expect(starts(slots)).toEqual(["2026-01-05T11:00:00.000Z"]);
    });
  });
});

describe("optimized slots", () => {
  const thirty: ServiceRules = { ...baseService, durationMinutes: 30, slotIntervalMinutes: 30 };
  const booked: Span = { start: at("2026-01-05T10:00:00Z"), end: at("2026-01-05T10:45:00Z") };
  const run = (service: ServiceRules, extra: Partial<Omit<PersonInput, "schedule">> = {}, over: Partial<SlotEngineInput> = {}) =>
    starts(offerableSlots(input({ service, people: [person({ schedule: hours(allDays, "UTC"), busy: [booked], ...extra })], ...over })));

  it("offers the start right after a booking while the 11:00 start still shows", () => {
    const times = run({ ...thirty, optimizedSlots: true });
    expect(times).toContain("2026-01-05T10:45:00.000Z");
    expect(times).toContain("2026-01-05T11:00:00.000Z");
    expect(times.indexOf("2026-01-05T10:45:00.000Z")).toBeLessThan(times.indexOf("2026-01-05T11:00:00.000Z"));
  });

  it("leaves the times unchanged when it is off", () => {
    const off = run(thirty);
    expect(off).not.toContain("2026-01-05T10:45:00.000Z");
    expect(run({ ...thirty, optimizedSlots: false })).toEqual(off);
    const on = run({ ...thirty, optimizedSlots: true });
    expect(on.filter((time) => time !== "2026-01-05T10:45:00.000Z")).toEqual(off);
  });

  it("also offers the start that ends exactly where a booking begins", () => {
    expect(run({ ...thirty, optimizedSlots: true })).toContain("2026-01-05T09:30:00.000Z");
  });

  it("respects buffers: the next start waits for the buffer before it", () => {
    const times = run({ ...thirty, bufferBeforeMinutes: 10, bufferAfterMinutes: 5, optimizedSlots: true }, { busy: [{ start: booked.start - 5 * 60_000, end: booked.end + 10 * 60_000 }] });
    // The booking's buffers end at 10:55 and the next visit needs 10 minutes before it starts.
    expect(times).toContain("2026-01-05T11:05:00.000Z");
    expect(times).not.toContain("2026-01-05T10:45:00.000Z");
  });

  it("never offers a start that overlaps another booking, even next to one", () => {
    const times = run({ ...thirty, optimizedSlots: true }, { busy: [booked, { start: at("2026-01-05T11:00:00Z"), end: at("2026-01-05T12:00:00Z") }] });
    expect(times).not.toContain("2026-01-05T10:45:00.000Z");
  });

  it("stays inside working hours, holidays and time off", () => {
    const edge = { start: at("2026-01-05T16:00:00Z"), end: at("2026-01-05T16:45:00Z") };
    expect(run({ ...thirty, optimizedSlots: true }, { busy: [edge] })).not.toContain("2026-01-05T16:45:00.000Z");
    expect(run({ ...thirty, optimizedSlots: true }, {}, { holidays: [{ date: "2026-01-05", name: "Holiday" }] })).toEqual([]);
    const away = { span: { start: at("2026-01-05T10:30:00Z"), end: at("2026-01-05T11:30:00Z") }, note: null };
    expect(run({ ...thirty, optimizedSlots: true }, { outOfOffice: [away] })).not.toContain("2026-01-05T10:45:00.000Z");
  });

  it("still applies the notice rule to the extra start", () => {
    const times = run({ ...thirty, optimizedSlots: true, minimumNoticeMinutes: 60 }, {}, { now: new Date("2026-01-05T10:00:00Z") });
    expect(times).not.toContain("2026-01-05T10:45:00.000Z");
  });

  it("does not add extra starts for walk-ins", () => {
    const times = run({ ...thirty, optimizedSlots: true }, {}, { mode: "walk_in", now: new Date("2026-01-05T09:50:00Z") });
    expect(times).not.toContain("2026-01-05T10:45:00.000Z");
  });
});
