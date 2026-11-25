import { describe, expect, it } from "vitest";

import { appointmentEventShouldGo, appointmentNeedsEvent, classifyExternalChange, eventContent, fieldsHash, planBusy } from "./logic";

const input = { firstName: "Priya", lastName: "Sharma", serviceName: "Haircut", locationName: "Indiranagar", appointmentUrl: "https://app.example.test/schedule?open=a1" };

describe("eventContent", () => {
  it("busy_only reveals nothing", () => {
    expect(eventContent("busy_only", input)).toEqual({ title: "Busy" });
  });

  it("first_name_service shows only the first name and the service", () => {
    const content = eventContent("first_name_service", input);
    expect(content).toEqual({ title: "Priya – Haircut" });
    expect(JSON.stringify(content)).not.toContain("Sharma");
  });

  it("full adds the surname, the place and a link back, but still no contact details", () => {
    const content = eventContent("full", input);
    expect(content.title).toBe("Haircut – Priya Sharma");
    expect(content.location).toBe("Indiranagar");
    expect(content.description).toContain("https://app.example.test/schedule?open=a1");
    expect(JSON.stringify(content)).not.toMatch(/@|\+91|phone/i);
  });
});

describe("fieldsHash", () => {
  const start = new Date("2026-12-01T10:00:00Z");
  const end = new Date("2026-12-01T10:30:00Z");
  it("is stable for the same content and changes with the text or the time", () => {
    const base = fieldsHash({ title: "Busy" }, start, end);
    expect(fieldsHash({ title: "Busy" }, start, end)).toBe(base);
    expect(fieldsHash({ title: "Other" }, start, end)).not.toBe(base);
    expect(fieldsHash({ title: "Busy" }, new Date("2026-12-01T11:00:00Z"), end)).not.toBe(base);
  });
});

describe("appointment states", () => {
  it("wants an event for live appointments and removes it only for cancelled ones", () => {
    for (const status of ["requested", "booked", "checked_in"]) expect(appointmentNeedsEvent(status)).toBe(true);
    for (const status of ["cancelled", "entered_in_error", "no_show"]) expect(appointmentEventShouldGo(status)).toBe(true);
    expect(appointmentEventShouldGo("completed")).toBe(false);
    expect(appointmentNeedsEvent("completed")).toBe(false);
  });
});

describe("planBusy", () => {
  const at = (hour: number) => `2026-12-01T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const event = (id: string, from: number, to: number, extra: Record<string, unknown> = {}) =>
    ({ sourceEventId: id, startsAt: at(from), endsAt: at(to), cancelled: false, ...extra });

  it("stores only real busy time", () => {
    const plan = planBusy("snapshot", [event("a", 9, 10), event("free", 11, 12, { transparent: true }), event("own", 13, 14), { sourceEventId: "gone", startsAt: null, endsAt: null, cancelled: true }], new Set(["own"]), []);
    expect(plan.upsert.map((row) => row.sourceEventId)).toEqual(["a"]);
    expect(plan.remove.sort()).toEqual(["free", "gone", "own"]);
  });

  it("a snapshot removes cached rows that are no longer in the window; a delta leaves them alone", () => {
    expect(planBusy("snapshot", [event("a", 9, 10)], new Set(), ["a", "stale"]).remove).toEqual(["stale"]);
    expect(planBusy("delta", [event("a", 9, 10)], new Set(), ["a", "stale"]).remove).toEqual([]);
  });

  it("a delta that cancels an event removes just that row", () => {
    const plan = planBusy("delta", [{ sourceEventId: "a", startsAt: null, endsAt: null, cancelled: true }], new Set(), ["a", "b"]);
    expect(plan).toEqual({ upsert: [], remove: ["a"] });
  });

  it("ignores an event whose end is not after its start", () => {
    expect(planBusy("snapshot", [event("odd", 10, 10)], new Set(), []).upsert).toEqual([]);
  });
});

describe("classifyExternalChange", () => {
  const link = { status: "active" as const, pushedStartsAt: new Date("2026-12-01T10:00:00Z"), pushedEndsAt: new Date("2026-12-01T10:30:00Z") };
  const appointment = { status: "booked", startsAt: new Date("2026-12-01T10:00:00Z"), endsAt: new Date("2026-12-01T10:30:00Z") };
  const event = (startsAt: string | null, endsAt: string | null, cancelled = false) => ({ startsAt, endsAt, cancelled });

  it("sees an event back in place", () => {
    expect(classifyExternalChange(link, event("2026-12-01T10:00:00.000Z", "2026-12-01T10:30:00.000Z"), appointment, false)).toEqual({ kind: "in_place" });
  });

  it("sees a move and a delete", () => {
    expect(classifyExternalChange(link, event("2026-12-02T10:00:00.000Z", "2026-12-02T10:30:00.000Z"), appointment, false)).toMatchObject({ kind: "moved" });
    expect(classifyExternalChange(link, event(null, null, true), appointment, false)).toEqual({ kind: "deleted" });
  });

  it("stays quiet while Kalendr's own write is waiting, after Kalendr deleted the event, and for finished appointments", () => {
    const moved = event("2026-12-02T10:00:00.000Z", "2026-12-02T10:30:00.000Z");
    expect(classifyExternalChange(link, moved, appointment, true)).toEqual({ kind: "none" });
    expect(classifyExternalChange({ ...link, status: "deleted" }, event(null, null, true), appointment, false)).toEqual({ kind: "none" });
    expect(classifyExternalChange(link, event(null, null, true), { ...appointment, status: "cancelled" }, false)).toEqual({ kind: "none" });
  });

  it("is not a conflict when the event already matches the appointment's new time", () => {
    const moved = { ...appointment, startsAt: new Date("2026-12-02T10:00:00Z"), endsAt: new Date("2026-12-02T10:30:00Z") };
    expect(classifyExternalChange(link, event("2026-12-02T10:00:00.000Z", "2026-12-02T10:30:00.000Z"), moved, false)).toEqual({ kind: "none" });
  });
});
