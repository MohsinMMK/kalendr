import { describe, expect, it, vi } from "vitest";

import fixture from "./__fixtures__/caldav-home.json";
import { createCalDavProvider } from "./caldav";
import type { CalDavApi, CalDavCalendar, CalDavObject } from "./caldav-api";
import { CalendarProviderError } from "./errors";
import { parseEvents } from "./ical";
import type { CalDavCredentials, EventInput } from "./provider";
import { allKeys, FORBIDDEN_FIELDS, NOW, WINDOW } from "./test-support";

const credentials: CalDavCredentials = { kind: "caldav", provider: "apple", serverUrl: "https://caldav.icloud.com", username: "asha@icloud.example", appPassword: "abcd-efgh-ijkl-mnop" };
const HOME = "https://p42-caldav.icloud.example/1234/calendars/home/";

function fakeApi(overrides: Partial<CalDavApi> = {}): CalDavApi & { created: { calendarUrl: string; filename: string; data: string }[]; updated: { url: string; data: string; etag: string | null }[] } {
  const created: { calendarUrl: string; filename: string; data: string }[] = [];
  const updated: { url: string; data: string; etag: string | null }[] = [];
  return {
    created,
    updated,
    listCalendars: async () => fixture.calendars as CalDavCalendar[],
    fetchEvents: async () => fixture.objects as CalDavObject[],
    createObject: async (input) => {
      created.push(input);
      return { etag: '"new-etag"' };
    },
    updateObject: async (input) => {
      updated.push(input);
      return { etag: '"updated-etag"' };
    },
    deleteObject: async () => undefined,
    getObject: async () => null,
    ...overrides,
  };
}

const provider = (api: CalDavApi) => createCalDavProvider({ apiFactory: () => api, now: () => NOW });
const request = { ...WINDOW, timezone: "Asia/Kolkata" };

describe("caldav adapter", () => {
  it("lists only event calendars and uses the collection URL as the id", async () => {
    const calendars = await provider(fakeApi()).listCalendars(credentials);
    expect(calendars.map((calendar) => calendar.id)).toEqual([HOME, "https://p42-caldav.icloud.example/1234/calendars/work/"]);
    expect(calendars[0]).toMatchObject({ name: "Home", primary: true });
  });

  it("reports the Apple ID as the account on verify", async () => {
    await expect(provider(fakeApi()).verifyAccount(credentials)).resolves.toEqual({ accountEmail: "asha@icloud.example" });
  });

  it("initial sync reads the window as a snapshot with the calendar's change tag", async () => {
    const result = await provider(fakeApi()).syncChanges(credentials, HOME, request);
    if (result.fullResyncRequired) throw new Error("unexpected resync");
    expect(result.mode).toBe("snapshot");
    expect(result.nextSyncToken).toBe("data:,17");
    const byId = Object.fromEntries(result.events.map((event) => [event.sourceEventId, event]));

    // TZID=Asia/Kolkata 10:00-11:00 is 04:30-05:30 UTC.
    expect(byId["single-1"]).toMatchObject({ startsAt: "2026-11-20T04:30:00.000Z", endsAt: "2026-11-20T05:30:00.000Z", cancelled: false, allDay: false });
    // All-day (VALUE=DATE, exclusive end) in the calendar's zone.
    expect(byId["allday-1"]).toMatchObject({ startsAt: "2026-11-20T18:30:00.000Z", endsAt: "2026-11-22T18:30:00.000Z", allDay: true });
    // Free time must not block.
    expect(byId["free-1"]?.transparent).toBe(true);
    expect(byId["single-1"]?.transparent).toBe(false);
    // Cancelled objects are reported as cancelled.
    expect(byId["cancelled-1"]?.cancelled).toBe(true);
    // Floating time with a duration uses the fallback zone.
    expect(byId["floating-1"]).toMatchObject({ startsAt: "2026-11-27T03:30:00.000Z", endsAt: "2026-11-27T05:00:00.000Z" });
  });

  it("expands recurring events inside the window, honouring EXDATE and moved occurrences", async () => {
    const result = await provider(fakeApi()).syncChanges(credentials, HOME, request);
    if (result.fullResyncRequired) throw new Error("unexpected resync");
    const weekly = result.events.filter((event) => event.sourceEventId.startsWith("weekly-1")).map((event) => [event.sourceEventId, event.startsAt]);
    expect(weekly).toEqual(
      expect.arrayContaining([
        // 3 Dec was edited to 15:00 IST (09:30 UTC) and keeps the id of the occurrence it replaced.
        ["weekly-1#2026-12-03T04:30:00.000Z", "2026-12-03T09:30:00.000Z"],
        ["weekly-1#2026-12-10T04:30:00.000Z", "2026-12-10T04:30:00.000Z"],
      ]),
    );
    // 19 Nov ended before the window, 26 Nov is an EXDATE, and 3 Dec is not also generated at 10:00.
    expect(weekly).toHaveLength(2);
    expect(result.events.filter((event) => event.sourceEventId.startsWith("monthly-1")).map((event) => event.startsAt?.slice(0, 10))).toEqual(["2026-12-25", "2027-01-29"]);
  });

  it("counts rules it cannot expand and still blocks the first occurrence", async () => {
    const result = await provider(fakeApi()).syncChanges(credentials, HOME, request);
    if (result.fullResyncRequired) throw new Error("unexpected resync");
    expect(result.unsupportedRecurrences).toBe(1);
    expect(result.events.some((event) => event.sourceEventId.startsWith("odd-1"))).toBe(true);
  });

  it("skips the read when the change tag has not moved", async () => {
    const fetchEvents = vi.fn(async () => []);
    const result = await provider(fakeApi({ fetchEvents })).syncChanges(credentials, HOME, { ...request, syncToken: "data:,17" });
    expect(result).toEqual({ fullResyncRequired: false, mode: "delta", events: [], nextSyncToken: "data:,17", unsupportedRecurrences: 0 });
    expect(fetchEvents).not.toHaveBeenCalled();
  });

  it("re-reads the window when the change tag moved, and falls back to ctag", async () => {
    const work = "https://p42-caldav.icloud.example/1234/calendars/work/";
    const result = await provider(fakeApi({ fetchEvents: async () => [] })).syncChanges(credentials, work, { ...request, syncToken: "FT=-@RU=old@S=1" });
    expect(result).toMatchObject({ mode: "snapshot", nextSyncToken: "FT=-@RU=b2@S=4" });
  });

  it("never returns a title, attendee, location or description", async () => {
    const result = await provider(fakeApi()).syncChanges(credentials, HOME, request);
    const keys = allKeys(result);
    for (const field of FORBIDDEN_FIELDS) expect(keys.has(field)).toBe(false);
    const text = JSON.stringify(result);
    for (const secret of ["Therapy", "Very private", "Somewhere", "dr.rao@example.test", "Standup", "Reminder"]) expect(text).not.toContain(secret);
  });

  it("an unknown calendar is not_found", async () => {
    await expect(provider(fakeApi()).syncChanges(credentials, "https://elsewhere.example/cal/", request)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("creates an event as UTC VEVENT with a deterministic id and returns the etag", async () => {
    const api = fakeApi();
    const input: EventInput = { title: "Haircut, Asha; first visit", description: "Line one\nLine two", start: "2026-11-20T04:30:00Z", end: "2026-11-20T05:30:00Z", timezone: "Asia/Kolkata", idempotencyKey: "outbox-1" };
    const first = await provider(api).createEvent(credentials, HOME, input);
    const again = await provider(api).createEvent(credentials, HOME, input);
    expect(first).toEqual({ eventId: again.eventId, etag: '"new-etag"' });
    const sent = api.created[0];
    expect(sent?.calendarUrl).toBe(HOME);
    expect(sent?.filename).toBe(`${first.eventId}.ics`);
    expect(sent?.data).toContain("DTSTART:20261120T043000Z");
    expect(sent?.data).toContain("DTEND:20261120T053000Z");
    expect(sent?.data).toContain("SUMMARY:Haircut\\, Asha\; first visit");
    expect(sent?.data).toContain("DESCRIPTION:Line one\\nLine two");
    expect(sent?.data.endsWith("\r\n")).toBe(true);
    // Round trip through our own parser.
    expect(parseEvents(sent?.data ?? "")[0]?.uid).toBe(first.eventId);
  });

  it("returns the existing event when the same key was already created", async () => {
    const api = fakeApi({
      createObject: async () => {
        throw new CalendarProviderError("conflict", "exists", { status: 412 });
      },
      getObject: async (url) => ({ url, etag: '"already"', data: "" }),
    });
    const result = await provider(api).createEvent(credentials, HOME, { title: "x", start: "2026-11-20T04:30:00Z", end: "2026-11-20T05:30:00Z", timezone: "UTC", idempotencyKey: "same" });
    expect(result.etag).toBe('"already"');
  });

  it("asks the server for the etag when a create does not return one", async () => {
    const api = fakeApi({ createObject: async () => ({ etag: null }), getObject: async (url) => ({ url, etag: '"fetched"', data: "" }) });
    const result = await provider(api).createEvent(credentials, HOME, { title: "x", start: "2026-11-20T04:30:00Z", end: "2026-11-20T05:30:00Z", timezone: "UTC" });
    expect(result.etag).toBe('"fetched"');
  });

  it("updates with If-Match and a rising sequence, and surfaces a stale etag as a conflict", async () => {
    const api = fakeApi();
    const input: EventInput = { title: "Moved", start: "2026-11-21T04:30:00Z", end: "2026-11-21T05:30:00Z", timezone: "UTC" };
    const result = await provider(api).updateEvent(credentials, HOME, "kalendr-abc", input, { etag: '"old"' });
    expect(result).toEqual({ eventId: "kalendr-abc", etag: '"updated-etag"' });
    expect(api.updated[0]).toMatchObject({ url: `${HOME}kalendr-abc.ics`, etag: '"old"' });
    expect(api.updated[0]?.data).toContain(`SEQUENCE:${Math.floor(NOW.getTime() / 1000)}`);

    const stale = fakeApi({
      updateObject: async () => {
        throw new CalendarProviderError("conflict", "changed", { status: 412 });
      },
    });
    await expect(provider(stale).updateEvent(credentials, HOME, "kalendr-abc", input, { etag: '"old"' })).rejects.toMatchObject({ kind: "conflict" });
  });

  it("deletes with the etag", async () => {
    const deleteObject = vi.fn(async () => undefined);
    await provider(fakeApi({ deleteObject })).deleteEvent(credentials, HOME, "kalendr-abc", { etag: '"e"' });
    expect(deleteObject).toHaveBeenCalledWith({ url: `${HOME}kalendr-abc.ics`, etag: '"e"' });
  });

  it("rejects an end before the start", async () => {
    await expect(provider(fakeApi()).createEvent(credentials, HOME, { title: "x", start: "2026-11-20T05:30:00Z", end: "2026-11-20T04:30:00Z", timezone: "UTC" })).rejects.toMatchObject({ kind: "invalid" });
  });

  it("has no push: watch is unsupported", async () => {
    const adapter = provider(fakeApi());
    expect(adapter.supportsPush).toBe(false);
    await expect(adapter.watch(credentials, HOME, { callbackUrl: "https://x.test", token: "t" })).rejects.toMatchObject({ kind: "unsupported" });
  });

  it("classifies a refused sign-in as revoked", async () => {
    const adapter = provider(fakeApi({ listCalendars: async () => Promise.reject(new CalendarProviderError("revoked", "401", { status: 401 })) }));
    const error = await adapter.listCalendars(credentials).catch((caught: unknown) => caught);
    expect(adapter.handleAuthFailure(error)).toEqual({ kind: "revoked" });
  });
});

describe("iCalendar parsing", () => {
  it("unfolds long lines and ignores VTIMEZONE and VALARM blocks", () => {
    const events = parseEvents("BEGIN:VCALENDAR\r\nBEGIN:VTIMEZONE\r\nBEGIN:STANDARD\r\nDTSTART:19450101T000000\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261120T100000Z\r\nDTEND:2026\r\n 1120T110000Z\r\nBEGIN:VALARM\r\nTRIGGER:-PT5M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.end?.hour).toBe(11);
  });
});
