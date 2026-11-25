import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { demoAppointments } from "@/lib/demo-data";
import { getPreviewDoctorState, savePreviewDoctor } from "@/lib/preview-doctors";
import { draftFromRules, draftToRules } from "@/lib/working-hours";

import { fitBreak } from "./hours-editor";
import { usePreviewAppointments } from "./preview-appointments";
import { defaultScheduleAvailability, draftToWorkingHours, slotAvailabilityIssue, visitFitsRules, workingHoursToDraft, workingHoursToRules } from "./schedule-availability";

afterEach(() => window.sessionStorage.clear());

const visit = (startsAt: string, endsAt: string) => ({ practitionerId: "doc", startsAt, endsAt });

describe("visitFitsRules", () => {
  const rules = draftToRules("doc", { days: [1], start: "09:00", end: "17:00", breakStart: "13:00", breakEnd: "14:00" });

  it("accepts a visit inside one working window", () => {
    expect(visitFitsRules(visit("2026-08-31T09:00:00+05:30", "2026-08-31T09:45:00+05:30"), rules)).toBe(true);
  });

  it("rejects visits over lunch, past closing, on a day off, or with another doctor", () => {
    expect(visitFitsRules(visit("2026-08-31T12:30:00+05:30", "2026-08-31T13:15:00+05:30"), rules)).toBe(false);
    expect(visitFitsRules(visit("2026-08-31T16:30:00+05:30", "2026-08-31T17:15:00+05:30"), rules)).toBe(false);
    expect(visitFitsRules(visit("2026-09-01T09:00:00+05:30", "2026-09-01T09:45:00+05:30"), rules)).toBe(false);
    expect(visitFitsRules({ ...visit("2026-08-31T09:00:00+05:30", "2026-08-31T09:45:00+05:30"), practitionerId: "other" }, rules)).toBe(false);
  });

  it("treats Sunday as the same day in preview hours and shared rules", () => {
    const sunday = workingHoursToRules("doc", { start: "09:00", end: "12:00", days: [0] });
    expect(sunday[0]?.dayOfWeek).toBe(7);
    expect(visitFitsRules(visit("2026-08-30T09:00:00+05:30", "2026-08-30T09:30:00+05:30"), sunday)).toBe(true);
  });
});

describe("hours drafts", () => {
  it("round trips preview hours, including Sunday and lunch", () => {
    const hours = { start: "09:00", end: "17:00", days: [0, 1], breakStart: "13:00", breakEnd: "14:00" };
    const draft = workingHoursToDraft(hours);
    expect(draft.days).toEqual([1, 7]);
    expect(draftToWorkingHours(draft)).toEqual({ ...hours, days: [1, 0] });
  });

  it("reads database rules with seconds, and recovers lunch from split windows", () => {
    const rule = (startsAtLocal: string, endsAtLocal: string) => ({ practitionerId: "doc", dayOfWeek: 2, startsAtLocal, endsAtLocal });
    expect(draftFromRules([rule("09:00:00", "13:00:00"), rule("14:00:00", "17:00:00")])).toEqual({
      draft: { days: [2], start: "09:00", end: "17:00", breakStart: "13:00", breakEnd: "14:00" },
      uniform: true,
    });
  });

  it("flags days that differ, because one draft would overwrite them", () => {
    const { uniform } = draftFromRules([
      { practitionerId: "doc", dayOfWeek: 1, startsAtLocal: "09:00", endsAtLocal: "17:00" },
      { practitionerId: "doc", dayOfWeek: 2, startsAtLocal: "10:00", endsAtLocal: "17:00" },
    ]);
    expect(uniform).toBe(false);
  });

  it("keeps lunch inside a shrinking day, and drops it when it can't fit", () => {
    const draft = { days: [1], start: "09:00", end: "17:00", breakStart: "13:00", breakEnd: "14:00" };
    expect(fitBreak({ ...draft, end: "13:30" })).toMatchObject({ breakStart: "13:00", breakEnd: "13:15" });
    expect(fitBreak({ ...draft, end: "13:00" })).toMatchObject({ breakStart: null, breakEnd: null });
  });
});

describe("lunch and openings", () => {
  it("refuses an opening that overlaps lunch", () => {
    const service = { durationMinutes: 45, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 };
    const availability = { ...defaultScheduleAvailability, workingHours: { doc: { start: "09:00", end: "17:00", days: [1], breakStart: "13:00", breakEnd: "14:00" } } };
    const slot = (time: string) => ({ id: "s", startsAt: `2026-08-31T${time}:00+05:30`, endsAt: "", practitionerId: "doc", resourceId: "r" });
    expect(slotAvailabilityIssue(slot("12:30"), service as never, availability)).toMatch(/do not fit/);
    expect(slotAvailabilityIssue(slot("14:00"), service as never, availability)).toBeNull();
  });
});

describe("saveDoctorHours", () => {
  async function loadedHook() {
    const hook = renderHook(() => usePreviewAppointments());
    await waitFor(() => expect(hook.result.current.appointments.length).toBeGreaterThan(0));
    return hook;
  }
  const upcomingWith = (appointments: typeof demoAppointments, practitionerId: string, clock: string) =>
    appointments.filter((item) => item.practitionerId === practitionerId && ["requested", "booked"].includes(item.status) && Date.parse(item.startsAt) > Date.parse(clock));

  it("moves every visit outside the new hours to one with the same doctor, and records a message", async () => {
    const { result } = await loadedHook();
    const clock = result.current.operations.clockIso;
    const doctor = upcomingWith(result.current.appointments, "practitioner_asha", clock).length ? "practitioner_asha" : "practitioner_mira";
    const before = upcomingWith(result.current.appointments, doctor, clock);
    expect(before.length).toBeGreaterThan(0);
    // A window that excludes every morning visit but stays open for the following days.
    const hours = { start: "19:00", end: "21:00", days: [1, 2, 3, 4, 5, 6] };
    const rules = workingHoursToRules(doctor, hours);
    const outside = before.filter((item) => !visitFitsRules(item, rules));
    let timing: ReturnType<typeof result.current.saveDoctorHours> = null;
    act(() => { timing = result.current.saveDoctorHours(doctor, hours); });
    expect(timing).not.toBeNull();
    const outcome = timing as unknown as { moved: { appointmentId: string; from: string; to: string }[]; unresolved: string[] };
    expect(outcome.moved.length + outcome.unresolved.length).toBe(outside.length);
    for (const move of outcome.moved) {
      const after = result.current.appointments.find((item) => item.id === move.appointmentId)!;
      expect(after.practitionerId).toBe(doctor);
      expect(after.startsAt).toBe(move.to);
      expect(after.clinicMovedFrom).toBe(move.from);
      expect(visitFitsRules(after, rules)).toBe(true);
    }
    expect(result.current.operations.messages).toHaveLength(outcome.moved.length);
    expect(result.current.operations.schedule.workingHours[doctor]).toEqual(hours);
  });

  it("never moves checked-in visits, and rejects invalid hours without saving", async () => {
    const { result } = await loadedHook();
    let timing: ReturnType<typeof result.current.saveDoctorHours> = null;
    act(() => { timing = result.current.saveDoctorHours("practitioner_asha", { start: "17:00", end: "09:00", days: [1] }); });
    expect(timing).toBeNull();
    const checkedIn = result.current.appointments.filter((item) => item.status === "checked_in");
    act(() => { result.current.saveDoctorHours("practitioner_asha", { start: "20:00", end: "21:00", days: [1] }); });
    expect(result.current.appointments.filter((item) => item.status === "checked_in").map((item) => item.startsAt)).toEqual(checkedIn.map((item) => item.startsAt));
  });
});

describe("preview doctors", () => {
  it("adds a doctor, links services, and survives a re-read", () => {
    savePreviewDoctor({ id: "practitioner_new", clinicId: "c", locationIds: ["loc_indiranagar"], name: "Dr New", title: "Physician", initials: "DN", specialty: "General", serviceIds: ["service_cleaning"] });
    const state = getPreviewDoctorState();
    expect(state.doctors.some((doctor) => doctor.id === "practitioner_new")).toBe(true);
    expect(state.services.find((service) => service.id === "service_cleaning")?.practitionerIds).toContain("practitioner_new");
    expect(state.services.find((service) => service.id !== "service_cleaning")?.practitionerIds).not.toContain("practitioner_new");
  });

  it("returns the same object until something changes, as useSyncExternalStore requires", () => {
    expect(getPreviewDoctorState()).toBe(getPreviewDoctorState());
  });
});
