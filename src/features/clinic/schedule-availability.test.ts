import { describe, expect, it } from "vitest";

import { demoAppointments, demoServices } from "@/lib/demo-data";
import type { Appointment } from "@/lib/domain";

import { appointmentHasConflict, compatibleSlots } from "./preview-appointments";
import { addClinicDays, clinicDateKey, defaultScheduleAvailability, scheduleBlockAffectsAppointment, slotAvailabilityIssue, workingHoursFromRules } from "./schedule-availability";

const cleaning = demoServices.find((item) => item.id === "service_cleaning")!;

function futureAppointment(changes: Partial<Appointment>): Appointment {
  return { ...demoAppointments[0], id: "future_test", startsAt: "2026-09-03T11:30:00+05:30", endsAt: "2026-09-03T12:15:00+05:30", ...changes };
}

describe("staff schedule availability", () => {
  it("reads saved database hours per doctor, including a lunch break", () => {
    const hours = workingHoursFromRules([
      { practitionerId: "doctor_a", dayOfWeek: 2, startsAtLocal: "09:00:00", endsAtLocal: "13:00:00" },
      { practitionerId: "doctor_a", dayOfWeek: 2, startsAtLocal: "14:00:00", endsAtLocal: "17:00:00" },
      { practitionerId: "doctor_a", dayOfWeek: 4, startsAtLocal: "09:00", endsAtLocal: "13:00" },
      { practitionerId: "doctor_a", dayOfWeek: 4, startsAtLocal: "14:00", endsAtLocal: "17:00" },
      { practitionerId: "doctor_b", dayOfWeek: 6, startsAtLocal: "10:00", endsAtLocal: "16:00" },
    ]);
    expect(hours.doctor_a).toEqual({ days: [2, 4], start: "09:00", end: "17:00", breakStart: "13:00", breakEnd: "14:00" });
    expect(hours.doctor_b).toEqual({ days: [6], start: "10:00", end: "16:00" });
    expect(hours.doctor_c).toBeUndefined();
  });


  it("uses clinic dates across UTC boundaries and rejects invalid calendar dates", () => {
    expect(clinicDateKey("2026-08-31T20:00:00Z")).toBe("2026-09-01");
    expect(addClinicDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(() => addClinicDays("2026-02-30", 1)).toThrow(RangeError);
  });

  it("reports bookings affected only through their before and after buffers", () => {
    const appointment = futureAppointment({ serviceId: cleaning.id });
    const afterBuffer = { id: "buffer_block", targetType: "resource" as const, targetId: "resource_hygiene", startsAt: "2026-09-03T12:15:00+05:30", endsAt: "2026-09-03T12:25:00+05:30", reason: "Maintenance" };
    expect(scheduleBlockAffectsAppointment(afterBuffer, appointment)).toBe(true);
    expect(slotAvailabilityIssue({ id: "candidate", startsAt: appointment.startsAt, endsAt: appointment.endsAt, practitionerId: appointment.practitionerId, resourceId: "resource_hygiene" }, cleaning, { ...defaultScheduleAvailability, blocks: [afterBuffer] })).toMatch(/Blocked/);
  });

  it("blocks the same practitioner or patient across locations and releases no-shows", () => {
    const otherLocation = futureAppointment({ locationId: "loc_koramangala", serviceId: "service_consultation", resourceIds: [], practitionerId: "practitioner_asha", patientId: "patient_priya" });
    const candidate = futureAppointment({ id: "candidate", practitionerId: "practitioner_mira", patientId: "patient_priya", resourceIds: ["resource_hygiene"] });
    expect(appointmentHasConflict(candidate, [otherLocation])).toBe(true);
    const withConflict = compatibleSlots({ service: cleaning, locationId: "loc_indiranagar", appointments: [otherLocation], dateKey: "2026-09-03", patientId: "patient_priya" });
    expect(withConflict.some((slot) => slot.startsAt === otherLocation.startsAt && slot.practitionerId === "practitioner_asha")).toBe(false);
    expect(withConflict.some((slot) => slot.startsAt === otherLocation.startsAt && slot.practitionerId === "practitioner_mira")).toBe(false);
    const released = compatibleSlots({ service: cleaning, locationId: "loc_indiranagar", appointments: [{ ...otherLocation, status: "no_show" }], dateKey: "2026-09-03", patientId: "patient_priya" });
    expect(released.some((slot) => slot.startsAt === otherLocation.startsAt && slot.practitionerId === "practitioner_asha")).toBe(true);
  });

  it("removes openings during saved blocked time and outside working hours", () => {
    const base = compatibleSlots({ service: cleaning, locationId: "loc_indiranagar", appointments: [], dateKey: "2026-09-03" });
    expect(base.some((slot) => slot.startsAt === "2026-09-03T12:00:00+05:30" && slot.practitionerId === "practitioner_mira")).toBe(true);
    const blocked = compatibleSlots({ service: cleaning, locationId: "loc_indiranagar", appointments: [], dateKey: "2026-09-03", availability: { ...defaultScheduleAvailability, blocks: [{ id: "leave", targetType: "practitioner", targetId: "practitioner_mira", startsAt: "2026-09-03T12:00:00+05:30", endsAt: "2026-09-03T13:00:00+05:30", reason: "Leave" }] } });
    expect(blocked.some((slot) => slot.startsAt === "2026-09-03T12:00:00+05:30" && slot.practitionerId === "practitioner_mira")).toBe(false);
    const earlyClose = compatibleSlots({ service: cleaning, locationId: "loc_indiranagar", appointments: [], dateKey: "2026-09-03", availability: { ...defaultScheduleAvailability, workingHours: { ...defaultScheduleAvailability.workingHours, practitioner_mira: { start: "08:30", end: "12:00", days: [4] } } } });
    expect(earlyClose.some((slot) => slot.startsAt === "2026-09-03T12:00:00+05:30" && slot.practitionerId === "practitioner_mira")).toBe(false);
  });
});
