import { describe, expect, it } from "vitest";

import { afterQuietHours, isQuietMinute, localMinuteOfDay } from "@/server/workflows/quiet-hours";

import {
  HOLD_GRACE_MS, MAX_PEOPLE_PER_TIME, localHourOf, mustReleaseToPublic, offerMinutes, orderCandidates, timeOfDayFits, type OrderableEntry,
} from "./waitlist";

const at = (iso: string) => new Date(iso);
const minutes = (value: number) => value * 60_000;

describe("how long a person has to answer", () => {
  it("is 15 minutes normally and 5 when the time is under three hours away", () => {
    const sendAt = at("2026-11-20T04:00:00Z");
    expect(offerMinutes(new Date(sendAt.getTime() + 24 * 60 * minutes(1)), sendAt)).toBe(15);
    expect(offerMinutes(new Date(sendAt.getTime() + minutes(181)), sendAt)).toBe(15);
    expect(offerMinutes(new Date(sendAt.getTime() + minutes(180)), sendAt)).toBe(15);
    expect(offerMinutes(new Date(sendAt.getTime() + minutes(179)), sendAt)).toBe(5);
    expect(offerMinutes(new Date(sendAt.getTime() + minutes(130)), sendAt)).toBe(5);
  });

  it("counts from when the message goes out, not from when the time freed up", () => {
    const freed = at("2026-11-20T20:00:00Z");
    const startsAt = at("2026-11-21T06:30:00Z");
    // Freed at night, sent next morning only 2.5 hours before the time: the short answer window applies.
    expect(offerMinutes(startsAt, freed)).toBe(15);
    expect(offerMinutes(startsAt, at("2026-11-21T04:00:00Z"))).toBe(5);
  });

  it("keeps the hold longer than the answer time so the worker moves on before it lapses", () => {
    expect(HOLD_GRACE_MS).toBeGreaterThanOrEqual(minutes(2));
  });
});

describe("when a time goes to public booking", () => {
  it("releases a time that is under two hours away and offers one that is two hours or more away", () => {
    const now = at("2026-11-20T10:00:00Z");
    expect(mustReleaseToPublic(new Date(now.getTime() + minutes(119)), now)).toBe(true);
    expect(mustReleaseToPublic(new Date(now.getTime() + minutes(120)), now)).toBe(false);
    expect(mustReleaseToPublic(new Date(now.getTime() - minutes(5)), now)).toBe(true);
  });

  it("asks at most three people about one time", () => {
    expect(MAX_PEOPLE_PER_TIME).toBe(3);
  });
});

describe("time of day", () => {
  it("uses the same boundaries as the staff screen's compatible openings", () => {
    expect([8, 11, 12].map((hour) => timeOfDayFits("morning", hour))).toEqual([true, true, false]);
    expect([11, 12, 16, 17].map((hour) => timeOfDayFits("afternoon", hour))).toEqual([false, true, true, false]);
    expect([16, 17, 20].map((hour) => timeOfDayFits("evening", hour))).toEqual([false, true, true]);
    expect([0, 9, 23].map((hour) => timeOfDayFits("any", hour))).toEqual([true, true, true]);
  });

  it("reads the hour on the place's own clock", () => {
    expect(localHourOf(at("2026-11-20T10:30:00Z"), "Asia/Kolkata")).toBe(16);
    expect(localHourOf(at("2026-11-20T10:30:00Z"), "UTC")).toBe(10);
    expect(localHourOf(at("2026-11-20T18:45:00Z"), "Asia/Kolkata")).toBe(0);
  });
});

describe("the order people are asked", () => {
  const entry = (id: string, joinedMinutesAgo: number, nextInDays: number | null): OrderableEntry => ({
    id,
    createdAt: new Date(Date.UTC(2026, 10, 20) - minutes(joinedMinutesAgo)),
    nextAppointmentAt: nextInDays === null ? null : new Date(Date.UTC(2026, 10, 20) + nextInDays * 86_400_000),
  });
  const people = [entry("recent-with-visit", 10, 3), entry("old-no-visit", 900, null), entry("middle-later-visit", 400, 9), entry("old-soon-visit", 800, 1)];

  it("asks the longest waiting first by default, whatever bookings they hold", () => {
    expect(orderCandidates(people, "longest_waiting").map((item) => item.id)).toEqual(["old-no-visit", "old-soon-visit", "middle-later-visit", "recent-with-visit"]);
  });

  it("asks the soonest existing booking first when the business chooses that, then people with no booking by waiting time", () => {
    expect(orderCandidates(people, "soonest_existing").map((item) => item.id)).toEqual(["old-soon-visit", "recent-with-visit", "middle-later-visit", "old-no-visit"]);
  });

  it("is stable: equal waiting falls back to the id, and the input is not changed", () => {
    const tied = [entry("b", 5, null), entry("a", 5, null)];
    expect(orderCandidates(tied, "longest_waiting").map((item) => item.id)).toEqual(["a", "b"]);
    expect(tied.map((item) => item.id)).toEqual(["b", "a"]);
  });
});

describe("quiet hours for an offer", () => {
  // The business's day: quiet from 9 pm to 8 am, in India.
  const start = 21 * 60;
  const end = 8 * 60;

  it("does not send at 2 am: the message waits until opening time in the place's own zone", () => {
    const twoAm = at("2026-11-20T20:30:00Z"); // 2:00 am on 21 November in India
    expect(localMinuteOfDay(twoAm, "Asia/Kolkata")).toBe(120);
    expect(isQuietMinute(120, start, end)).toBe(true);
    const sendAt = afterQuietHours(twoAm, "Asia/Kolkata", start, end);
    expect(sendAt.toISOString()).toBe("2026-11-21T02:30:00.000Z"); // 8:00 am in India
  });

  it("sends at once during the day", () => {
    const noon = at("2026-11-20T06:30:00Z"); // noon in India
    expect(afterQuietHours(noon, "Asia/Kolkata", start, end)).toEqual(noon);
  });

  it("starts the answer clock at opening time, so an offer made at night does not run out before anyone is awake", () => {
    const sendAt = afterQuietHours(at("2026-11-20T20:30:00Z"), "Asia/Kolkata", start, end);
    const startsAt = new Date(sendAt.getTime() + minutes(600));
    expect(offerMinutes(startsAt, sendAt)).toBe(15);
    expect(mustReleaseToPublic(startsAt, sendAt)).toBe(false);
    // A time at 9 am is under two hours after opening, so it is released instead of being offered at dawn.
    expect(mustReleaseToPublic(new Date(sendAt.getTime() + minutes(60)), sendAt)).toBe(true);
  });
});
