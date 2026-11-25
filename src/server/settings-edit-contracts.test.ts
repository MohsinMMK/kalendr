import { describe, expect, it } from "vitest";

import {
  staffBusinessProfileSchema,
  staffClinicProfileSchema,
  staffCreateScheduleBlockSchema,
  staffUpdateResourceSchema,
  staffUpdateScheduleBlockSchema,
  staffUpdateServiceSchema,
} from "./contracts";

describe("editing settings that used to be create-only", () => {
  it("renames or switches off a room, and refuses an empty change", () => {
    expect(staffUpdateResourceSchema.parse({ name: "  Chair 2 " })).toEqual({ name: "Chair 2" });
    expect(staffUpdateResourceSchema.safeParse({ isActive: false }).success).toBe(true);
    expect(staffUpdateResourceSchema.safeParse({}).success).toBe(false);
    expect(staffUpdateResourceSchema.safeParse({ name: "x" }).success).toBe(false);
  });

  it("does not let a room change its kind through the update", () => {
    expect(staffUpdateResourceSchema.parse({ name: "Room 1", kind: "chair" })).toEqual({ name: "Room 1" });
  });

  it("changes where a service is offered, but never to nowhere", () => {
    expect(staffUpdateServiceSchema.safeParse({ locationIds: ["loc_a", "loc_b"] }).success).toBe(true);
    expect(staffUpdateServiceSchema.safeParse({ locationIds: [] }).success).toBe(false);
  });

  it("edits the location name and legal name with the clinic details", () => {
    const parsed = staffClinicProfileSchema.parse({ legalName: "Cedar Hair Pvt Ltd", locationName: " Main studio " });
    expect(parsed).toMatchObject({ legalName: "Cedar Hair Pvt Ltd", locationName: "Main studio" });
    expect(staffClinicProfileSchema.safeParse({ locationName: "x" }).success).toBe(false);
  });

  it("holds an edited closed time to the same rules as a new one", () => {
    const valid = { startsAt: "2026-08-31T09:00:00+05:30", endsAt: "2026-08-31T13:00:00+05:30", practitionerId: null, reason: "Meeting" };
    const backwards = { ...valid, endsAt: "2026-08-31T08:00:00+05:30" };
    expect(staffUpdateScheduleBlockSchema.safeParse(valid).success).toBe(true);
    for (const schema of [staffCreateScheduleBlockSchema, staffUpdateScheduleBlockSchema]) {
      const result = schema.safeParse(backwards);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe("End time must be after start time.");
    }
  });

  it("carries the booking page clock and week start with the business profile, and refuses anything else", () => {
    const base = { businessType: "healthcare", terminology: {}, features: {} };
    expect(staffBusinessProfileSchema.parse(base)).toEqual(base);
    expect(staffBusinessProfileSchema.parse({ ...base, defaultClock: "24h", weekStart: 7 })).toMatchObject({ defaultClock: "24h", weekStart: 7 });
    expect(staffBusinessProfileSchema.safeParse({ ...base, defaultClock: "military" }).success).toBe(false);
    expect(staffBusinessProfileSchema.safeParse({ ...base, weekStart: 3 }).success).toBe(false);
  });
});
