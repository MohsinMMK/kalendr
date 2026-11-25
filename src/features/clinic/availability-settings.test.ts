import { describe, expect, it } from "vitest";

import { staffUpdateScheduleBlockSchema } from "@/server/contracts";

import { closedTimeFormFor, closedTimeRange } from "./availability-settings";

describe("closed time editing", () => {
  it("reads an all-day block back as an all-day form", () => {
    const form = closedTimeFormFor({ startsAt: "2026-09-01T00:00:00+05:30", endsAt: "2026-09-02T00:00:00+05:30" });
    expect(form).toMatchObject({ date: "2026-09-01", allDay: true });
  });

  it("reads a part-day block back with its times", () => {
    const form = closedTimeFormFor({ startsAt: "2026-09-01T09:30:00+05:30", endsAt: "2026-09-01T13:00:00+05:30" });
    expect(form).toEqual({ date: "2026-09-01", allDay: false, start: "09:30", end: "13:00" });
  });

  it("does not offer to edit a block that spans several days", () => {
    expect(closedTimeFormFor({ startsAt: "2026-09-01T00:00:00+05:30", endsAt: "2026-09-04T00:00:00+05:30" })).toBeNull();
  });

  it("round-trips into a body the update API accepts", () => {
    const form = closedTimeFormFor({ startsAt: "2026-09-01T09:30:00+05:30", endsAt: "2026-09-01T13:00:00+05:30" })!;
    const body = { ...closedTimeRange({ ...form, end: "14:00" }), practitionerId: null, locationId: null, reason: "Meeting" };
    expect(body.endsAt).toBe("2026-09-01T14:00:00+05:30");
    expect(staffUpdateScheduleBlockSchema.safeParse(body).success).toBe(true);
  });
});
