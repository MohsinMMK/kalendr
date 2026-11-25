import { describe, expect, it } from "vitest";

import { staffAppointmentMutationSchema } from "@/server/contracts";

const base = { action: "details", expectedVersion: 3 };

describe("staff visit details action", () => {
  it("accepts a reason, notes and custom fields", () => {
    const parsed = staffAppointmentMutationSchema.parse({
      ...base,
      reasonForVisit: "  Check-up  ",
      notes: "Bring the earlier report",
      customFields: { cf_abcd1: "Gold", cf_abcd2: ["o_aaaa1"], cf_abcd3: 4, cf_abcd4: true },
    });
    expect(parsed).toMatchObject({ action: "details", reasonForVisit: "Check-up" });
  });

  it("keeps an empty string so it can clear the value", () => {
    const parsed = staffAppointmentMutationSchema.parse({ ...base, reasonForVisit: "", notes: "" });
    expect(parsed).toMatchObject({ reasonForVisit: "", notes: "" });
  });

  it("rejects text that is too long", () => {
    expect(staffAppointmentMutationSchema.safeParse({ ...base, reasonForVisit: "a".repeat(501) }).success).toBe(false);
    expect(staffAppointmentMutationSchema.safeParse({ ...base, notes: "a".repeat(2001) }).success).toBe(false);
  });

  it("rejects a bad custom field id", () => {
    expect(staffAppointmentMutationSchema.safeParse({ ...base, customFields: { name: "x" } }).success).toBe(false);
  });

  it("rejects a request that changes nothing", () => {
    expect(staffAppointmentMutationSchema.safeParse(base).success).toBe(false);
  });

  it("requires the expected version", () => {
    expect(staffAppointmentMutationSchema.safeParse({ action: "details", notes: "x" }).success).toBe(false);
  });
});

describe("staff visit corrections", () => {
  it("lets staff correct how they took the booking", () => {
    expect(staffAppointmentMutationSchema.parse({ ...base, bookingSource: "phone" })).toMatchObject({ bookingSource: "phone" });
  });

  it("never lets a booking be relabelled as an online one", () => {
    expect(staffAppointmentMutationSchema.safeParse({ ...base, bookingSource: "online" }).success).toBe(false);
  });
});

describe("staff moves to another service or room", () => {
  const move = { action: "reschedule", startsAt: "2026-09-01T10:00:00+05:30", practitionerId: "prac_1", expectedVersion: 2 };

  it("accepts a new service and a chosen room", () => {
    expect(staffAppointmentMutationSchema.parse({ ...move, serviceId: "svc_1", resourceId: "res_1" })).toMatchObject({ serviceId: "svc_1", resourceId: "res_1" });
  });

  it("still accepts a plain move", () => {
    expect(staffAppointmentMutationSchema.safeParse(move).success).toBe(true);
  });

  it("rejects a malformed service id", () => {
    expect(staffAppointmentMutationSchema.safeParse({ ...move, serviceId: "bad id!" }).success).toBe(false);
  });
});
