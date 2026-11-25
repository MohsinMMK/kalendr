import { describe, expect, it } from "vitest";

import { parseIcsTime, type IcsTime } from "./ical";
import { expandOccurrences } from "./recurrence";

function time(value: string, tzid?: string): IcsTime {
  const parsed = parseIcsTime(value, tzid ? { TZID: tzid } : {});
  if (!parsed) throw new Error("bad test time");
  return parsed;
}

function expand(rrule: string, start: IcsTime, zone: string, from: string, to: string, exdates: IcsTime[] = [], durationMs = 3_600_000) {
  return expandOccurrences({ start, zone, durationMs, rrule, exdates, windowStart: new Date(from), windowEnd: new Date(to) });
}

const starts = (result: ReturnType<typeof expand>) => result.occurrences.map((occurrence) => occurrence.startsAt);

describe("recurrence expansion", () => {
  it("expands DAILY with COUNT and stops after the count", () => {
    const result = expand("FREQ=DAILY;COUNT=3", time("20261120T090000Z"), "UTC", "2026-11-01T00:00:00Z", "2027-01-01T00:00:00Z");
    expect(starts(result)).toEqual(["2026-11-20T09:00:00.000Z", "2026-11-21T09:00:00.000Z", "2026-11-22T09:00:00.000Z"]);
  });

  it("counts occurrences before the window towards COUNT", () => {
    const result = expand("FREQ=DAILY;COUNT=5", time("20261110T090000Z"), "UTC", "2026-11-13T00:00:00Z", "2027-01-01T00:00:00Z");
    expect(starts(result)).toEqual(["2026-11-13T09:00:00.000Z", "2026-11-14T09:00:00.000Z"]);
  });

  it("handles WEEKLY with BYDAY and INTERVAL=2", () => {
    const result = expand("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", time("20261102T100000Z"), "UTC", "2026-11-01T00:00:00Z", "2026-12-07T00:00:00Z");
    // Mon 2, Wed 4, then two weeks on: Mon 16, Wed 18, Mon 30, Wed Dec 2
    expect(starts(result).map((value) => value.slice(0, 10))).toEqual(["2026-11-02", "2026-11-04", "2026-11-16", "2026-11-18", "2026-11-30", "2026-12-02"]);
  });

  it("handles MONTHLY on the last Friday, and UNTIL", () => {
    const result = expand("FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20270131T000000Z", time("20261225T060000Z"), "UTC", "2026-11-01T00:00:00Z", "2027-06-01T00:00:00Z");
    expect(starts(result).map((value) => value.slice(0, 10))).toEqual(["2026-12-25", "2027-01-29"]);
  });

  it("handles MONTHLY BYMONTHDAY with a negative day and skips short months", () => {
    const last = expand("FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3", time("20261130T080000Z"), "UTC", "2026-11-01T00:00:00Z", "2027-06-01T00:00:00Z");
    expect(starts(last).map((value) => value.slice(0, 10))).toEqual(["2026-11-30", "2026-12-31", "2027-01-31"]);
    const thirtyFirst = expand("FREQ=MONTHLY;COUNT=3", time("20260131T080000Z"), "UTC", "2026-01-01T00:00:00Z", "2027-06-01T00:00:00Z");
    // January 31st, then months that have a 31st.
    expect(starts(thirtyFirst).map((value) => value.slice(0, 10))).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]);
  });

  it("handles YEARLY", () => {
    const result = expand("FREQ=YEARLY;COUNT=3", time("20261119T080000Z"), "UTC", "2026-01-01T00:00:00Z", "2030-01-01T00:00:00Z");
    expect(starts(result).map((value) => value.slice(0, 10))).toEqual(["2026-11-19", "2027-11-19", "2028-11-19"]);
  });

  it("keeps 09:00 local across a daylight-saving change", () => {
    const result = expand("FREQ=WEEKLY;COUNT=3", time("20260305T090000", "America/New_York"), "America/New_York", "2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z");
    // Mar 5 is EST (UTC-5); Mar 12 and 19 are EDT (UTC-4) after the 8 March change.
    expect(starts(result)).toEqual(["2026-03-05T14:00:00.000Z", "2026-03-12T13:00:00.000Z", "2026-03-19T13:00:00.000Z"]);
  });

  it("removes EXDATE occurrences without shortening COUNT", () => {
    const result = expand("FREQ=DAILY;COUNT=3", time("20261120T090000Z"), "UTC", "2026-11-01T00:00:00Z", "2027-01-01T00:00:00Z", [time("20261121T090000Z")]);
    expect(starts(result)).toEqual(["2026-11-20T09:00:00.000Z", "2026-11-22T09:00:00.000Z"]);
  });

  it("only returns occurrences that overlap the window", () => {
    const result = expand("FREQ=DAILY", time("20260101T090000Z"), "UTC", "2026-11-19T09:30:00Z", "2026-11-20T09:30:00Z");
    expect(starts(result)).toEqual(["2026-11-19T09:00:00.000Z", "2026-11-20T09:00:00.000Z"]);
  });

  it("expands all-day events in the given zone", () => {
    const result = expand("FREQ=DAILY;COUNT=2", time("20261121"), "Asia/Kolkata", "2026-11-01T00:00:00Z", "2027-01-01T00:00:00Z", [], 86_400_000);
    expect(starts(result)).toEqual(["2026-11-20T18:30:00.000Z", "2026-11-21T18:30:00.000Z"]);
  });

  it("flags rules it cannot expand and keeps the first occurrence", () => {
    const result = expand("FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=1", time("20261130T060000Z"), "UTC", "2026-11-01T00:00:00Z", "2027-06-01T00:00:00Z");
    expect(result.unsupported).toBe(true);
    expect(starts(result)).toEqual(["2026-11-30T06:00:00.000Z"]);
    expect(expand("FREQ=HOURLY", time("20261130T060000Z"), "UTC", "2026-11-01T00:00:00Z", "2027-06-01T00:00:00Z").unsupported).toBe(true);
  });
});
