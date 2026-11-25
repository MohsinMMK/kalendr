import { describe, expect, it } from "vitest";

import { demoAppointments } from "@/lib/demo-data";
import type { Appointment } from "@/lib/domain";

import { lateLabel } from "./clinic-today";
import { patientBookingContext } from "./patient-directory";
import { toE164 } from "./patient-details-dialog";

const clock = "2026-08-31T10:45:00+05:30";
const visit = (startsAt: string, status: Appointment["status"]): Appointment => ({ ...demoAppointments[0], id: `visit_${startsAt}`, patientId: "patient_test", startsAt, endsAt: startsAt, status });

describe("patientBookingContext", () => {
  it("treats a booked visit earlier today as the next visit, not as having none", () => {
    const earlierToday = visit("2026-08-31T09:30:00+05:30", "booked");
    expect(patientBookingContext("patient_test", [earlierToday], clock)).toEqual({ kind: "next", appointment: earlierToday });
  });

  it("prefers today's open visit over a completed one", () => {
    const completed = visit("2026-08-20T09:30:00+05:30", "completed");
    const earlierToday = visit("2026-08-31T09:30:00+05:30", "requested");
    expect(patientBookingContext("patient_test", [completed, earlierToday], clock)?.appointment).toBe(earlierToday);
  });

  it("doesn't count a booking left open on an earlier day", () => {
    const forgotten = visit("2026-08-30T09:30:00+05:30", "booked");
    expect(patientBookingContext("patient_test", [forgotten], clock)).toBeNull();
  });
});

describe("lateLabel", () => {
  it("stays quiet until a visit is a full minute past its start", () => {
    expect(lateLabel("2026-08-31T10:45:00+05:30", clock)).toBeNull();
    expect(lateLabel("2026-08-31T11:00:00+05:30", clock)).toBeNull();
  });

  it("uses minutes, then hours", () => {
    expect(lateLabel("2026-08-31T10:20:00+05:30", clock)).toBe("Late 25 min");
    expect(lateLabel("2026-08-31T08:30:00+05:30", clock)).toBe("Late 2h 15m");
    expect(lateLabel("2026-08-31T09:45:00+05:30", clock)).toBe("Late 1h");
  });
});

describe("toE164", () => {
  it("reads a phone typed any which way for the phone field", () => {
    expect(toE164("+91 98765 43210")).toBe("+919876543210");
    expect(toE164("98765 43210")).toBe("+919876543210");
    expect(toE164("919876543210")).toBe("+919876543210");
    expect(toE164("")).toBe("");
  });
});
