import { afterEach, describe, expect, it, vi } from "vitest";

import { copySchedule, copyScheduleToPerson, createTimeOff, deleteTravel, putHolidays, updateSchedule, updateTimeOff } from "./availability-api";

const weekly = { "1": [], "2": [], "3": [], "4": [], "5": [], "6": [], "7": [] };
const schedule = { id: "s1", practitionerId: "p1", name: "Working hours", timezone: "UTC", isDefault: true, version: 2, weekly, overrides: [] };

function reply(data: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify({ data }), { status }));
}

afterEach(() => vi.unstubAllGlobals());

describe("availability client", () => {
  it("unwraps the schedule from the PATCH answer", async () => {
    const fetchMock = reply({ schedule, timing: { moved: [], unresolved: [] } });
    vi.stubGlobal("fetch", fetchMock);
    expect((await updateSchedule("s1", { expectedVersion: 1, name: "x" })).version).toBe(2);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/staff/availability/schedules/s1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ expectedVersion: 1, name: "x" });
  });

  it("copies for the same person through create, and for another person through the copy route", async () => {
    const fetchMock = reply(schedule, 201);
    vi.stubGlobal("fetch", fetchMock);
    await copySchedule(schedule, "Summer");
    await copyScheduleToPerson("s1", { toPractitionerId: "p2" });
    const [first, second] = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(first[0]).toBe("/api/staff/availability/schedules");
    expect(JSON.parse(String(first[1].body))).toEqual({ practitionerId: "p1", name: "Summer", copyFromScheduleId: "s1" });
    expect(second[0]).toBe("/api/staff/availability/schedules/s1/copy");
    expect(second[1].method).toBe("POST");
    expect(JSON.parse(String(second[1].body))).toEqual({ toPractitionerId: "p2" });
  });

  it("deletes a travel period by its path and sends time off with the right verbs", async () => {
    const fetchMock = reply({});
    vi.stubGlobal("fetch", fetchMock);
    await deleteTravel("t1");
    expect(fetchMock.mock.calls[0] as unknown[]).toEqual(["/api/staff/availability/travel/t1", expect.objectContaining({ method: "DELETE" })]);
    const timeOff = { id: "o1", practitionerId: "p1", startsOn: "2026-12-01", throughDate: "2026-12-02", reason: "leave", publicNote: null, coverPractitionerId: null, version: 1 };
    vi.stubGlobal("fetch", reply(timeOff));
    await createTimeOff({ practitionerId: "p1" });
    const patch = reply({ ...timeOff, version: 2 });
    vi.stubGlobal("fetch", patch);
    expect((await updateTimeOff("o1", { expectedVersion: 1, reason: "sick" })).version).toBe(2);
    expect((patch.mock.calls[0] as unknown[])[0]).toBe("/api/staff/availability/time-off/o1");
  });

  it("saves holidays with PUT and returns the listing", async () => {
    const listing = { settings: null, suggestedCountry: null, countries: [], regions: [], holidays: [], dataAvailable: true };
    const fetchMock = reply(listing);
    vi.stubGlobal("fetch", fetchMock);
    expect(await putHolidays({ country: "IN" })).toEqual(listing);
    expect(fetchMock.mock.calls[0] as unknown[]).toEqual(["/api/staff/holidays", expect.objectContaining({ method: "PUT" })]);
  });
});
