import { describe, expect, it } from "vitest";

import {
  expandWorkingHourWindows,
  formatHoursSummary,
  groupRulesIntoWindows,
  windowsShareHours,
} from "./working-hours";

describe("working hours", () => {
  it("does not invent a lunch break from duplicate, overlapping, or adjacent team hours", () => {
    expect(formatHoursSummary([
      { practitionerId: "p1", dayOfWeek: 1, startsAtLocal: "09:00", endsAtLocal: "17:00" },
      { practitionerId: "p2", dayOfWeek: 1, startsAtLocal: "09:00", endsAtLocal: "17:00" },
      { practitionerId: "p3", dayOfWeek: 1, startsAtLocal: "10:00", endsAtLocal: "12:00" },
      { practitionerId: "p4", dayOfWeek: 1, startsAtLocal: "17:00", endsAtLocal: "18:00" },
    ])).toBe("Mon 9 am–6 pm");
  });

  it("splits a lunch break into two bookable windows", () => {
    expect(expandWorkingHourWindows({
      days: [1, 2],
      startsAtLocal: "09:00",
      endsAtLocal: "17:00",
      breakStartsAtLocal: "13:00",
      breakEndsAtLocal: "14:00",
    })).toEqual([
      { dayOfWeek: 1, startsAtLocal: "09:00", endsAtLocal: "13:00" },
      { dayOfWeek: 1, startsAtLocal: "14:00", endsAtLocal: "17:00" },
      { dayOfWeek: 2, startsAtLocal: "09:00", endsAtLocal: "13:00" },
      { dayOfWeek: 2, startsAtLocal: "14:00", endsAtLocal: "17:00" },
    ]);
  });

  it("keeps a short Saturday without lunch when the break does not fit", () => {
    expect(expandWorkingHourWindows({
      windows: [
        { dayOfWeek: 1, startsAtLocal: "09:00", endsAtLocal: "17:00", breakStartsAtLocal: "13:00", breakEndsAtLocal: "14:00" },
        { dayOfWeek: 6, startsAtLocal: "09:00", endsAtLocal: "13:00", breakStartsAtLocal: "13:00", breakEndsAtLocal: "14:00" },
      ],
    })).toEqual([
      { dayOfWeek: 1, startsAtLocal: "09:00", endsAtLocal: "13:00" },
      { dayOfWeek: 1, startsAtLocal: "14:00", endsAtLocal: "17:00" },
      { dayOfWeek: 6, startsAtLocal: "09:00", endsAtLocal: "13:00" },
    ]);
  });

  it("rebuilds lunch from two stored rules and summarizes mixed days", () => {
    const windows = groupRulesIntoWindows([
      { practitionerId: "p1", dayOfWeek: 1, startsAtLocal: "09:00", endsAtLocal: "13:00" },
      { practitionerId: "p1", dayOfWeek: 1, startsAtLocal: "14:00", endsAtLocal: "17:00" },
      { practitionerId: "p1", dayOfWeek: 6, startsAtLocal: "09:00", endsAtLocal: "13:00" },
    ]);
    expect(windows).toEqual([
      { dayOfWeek: 1, startsAtLocal: "09:00", endsAtLocal: "17:00", breakStartsAtLocal: "13:00", breakEndsAtLocal: "14:00" },
      { dayOfWeek: 6, startsAtLocal: "09:00", endsAtLocal: "13:00" },
    ]);
    expect(windowsShareHours(windows)).toBe(false);
    expect(formatHoursSummary([
      { practitionerId: "p1", dayOfWeek: 1, startsAtLocal: "09:00", endsAtLocal: "13:00" },
      { practitionerId: "p1", dayOfWeek: 1, startsAtLocal: "14:00", endsAtLocal: "17:00" },
      { practitionerId: "p1", dayOfWeek: 2, startsAtLocal: "09:00", endsAtLocal: "13:00" },
      { practitionerId: "p1", dayOfWeek: 2, startsAtLocal: "14:00", endsAtLocal: "17:00" },
      { practitionerId: "p1", dayOfWeek: 6, startsAtLocal: "09:00", endsAtLocal: "13:00" },
    ])).toBe("Mon–Tue 9 am–5 pm, lunch 1 pm–2 pm · Sat 9 am–1 pm");
  });
});
