import { describe, expect, it } from "vitest";

import type { TimeSlot } from "@/lib/domain";

import { cellMinutesFor, visibleHours } from "./kloq-times";

const slot = (startsAt: string, minutes = 30): TimeSlot => ({
  id: startsAt,
  practitionerId: "p",
  startsAt,
  endsAt: new Date(Date.parse(startsAt) + minutes * 60_000).toISOString(),
});

describe("Kloq hours on a daylight-saving day", () => {
  it("counts the hours on the wall clock, so the clocks going back do not hide the first opening", () => {
    // New York, Sunday 1 November 2026: 9:00 and 16:30 after the clocks went back an hour at 2:00.
    const slots = [slot("2026-11-01T14:00:00Z"), slot("2026-11-01T21:30:00Z")];
    expect(visibleHours(slots, "America/New_York", 30)).toEqual({ dayStartHour: 9, dayEndHour: 17 });
    expect(cellMinutesFor(slots, "America/New_York")).toBe(30);
  });

  it("does the same when the clocks go forward", () => {
    // New York, Sunday 8 March 2026: 9:00 after the clocks went forward at 2:00.
    expect(visibleHours([slot("2026-03-08T13:00:00Z")], "America/New_York", 30)).toEqual({ dayStartHour: 9, dayEndHour: 11 });
  });

  it("reads a half-hour zone's openings on its own clock", () => {
    // Kolkata 10:30 and 11:00.
    expect(cellMinutesFor([slot("2026-12-03T05:00:00Z"), slot("2026-12-03T05:30:00Z")], "Asia/Kolkata")).toBe(30);
  });
});
