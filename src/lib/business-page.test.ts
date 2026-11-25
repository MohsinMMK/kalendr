import { describe, expect, it } from "vitest";

import {
  bookingHref,
  countFreeTimes,
  dateKeyIn,
  dayChipLabel,
  firstName,
  formatDayHours,
  freeDayQueries,
  freeDaysFromTimes,
  freeTimesByPerson,
  matchesSearch,
  mergeFreeDays,
  mergeFreeTimes,
  nextFreeDaysByPerson,
  openingHoursFromRules,
  serviceCategories,
  dayChipParts,
  lowestPrice,
  pricePillLabel,
  startingPrice,
  sortByPopularity,
  todayStatus,
  weekdayIndexIn,
} from "./business-page";

describe("openingHoursFromRules", () => {
  it("opens a location from the earliest start to the latest end of anyone working that day", () => {
    const hours = openingHoursFromRules([
      { locationId: "a", dayOfWeek: 1, startsAtLocal: "10:00:00", endsAtLocal: "14:00:00" },
      { locationId: "a", dayOfWeek: 1, startsAtLocal: "09:00:00", endsAtLocal: "13:00:00" },
      { locationId: "a", dayOfWeek: 1, startsAtLocal: "12:00:00", endsAtLocal: "18:30:00" },
      { locationId: "a", dayOfWeek: 7, startsAtLocal: "08:00", endsAtLocal: "12:00" },
      { locationId: "a", dayOfWeek: 9, startsAtLocal: "08:00", endsAtLocal: "12:00" },
    ]);
    expect(hours.a[0]).toEqual({ opens: "09:00", closes: "18:30" });
    expect(hours.a[1]).toBeNull();
    expect(hours.a[6]).toEqual({ opens: "08:00", closes: "12:00" });
    expect(hours.a).toHaveLength(7);
  });
});

describe("dates and days", () => {
  it("reads the weekday and date in the business's time zone", () => {
    // 20:00 UTC on Wednesday 11 Nov 2026 is already Thursday in Kolkata.
    const now = new Date("2026-11-11T20:00:00Z");
    expect(weekdayIndexIn("Asia/Kolkata", now)).toBe(3);
    expect(weekdayIndexIn("UTC", now)).toBe(2);
    expect(dateKeyIn(now, "Asia/Kolkata")).toBe("2026-11-12");
  });

  it("labels free days as Today, Tomorrow or a short date", () => {
    expect(dayChipLabel("2026-11-11", "2026-11-11", "en-GB")).toBe("Today");
    expect(dayChipLabel("2026-11-12", "2026-11-11", "en-GB")).toBe("Tomorrow");
    expect(dayChipLabel("2026-11-14", "2026-11-11", "en-GB")).toMatch(/Sat.*14.*Nov/);
  });

  it("says Closed for a day with no hours", () => {
    expect(formatDayHours(null, "en-GB")).toBe("Closed");
    expect(formatDayHours({ opens: "09:00", closes: "17:30" }, "en-GB")).toMatch(/^0?9:00 – 17:30$/);
  });
});

describe("free days", () => {
  it("keeps each person's first few days in order", () => {
    const days = nextFreeDaysByPerson(
      [
        { startsAt: "2026-11-13T04:00:00Z", practitionerId: "p1" },
        { startsAt: "2026-11-12T04:00:00Z", practitionerId: "p1" },
        { startsAt: "2026-11-12T06:00:00Z", practitionerId: "p1" },
        { startsAt: "2026-11-16T04:00:00Z", practitionerId: "p1" },
        { startsAt: "2026-11-17T04:00:00Z", practitionerId: "p1" },
        { startsAt: "2026-11-14T04:00:00Z", practitionerId: "p2" },
      ],
      "UTC",
    );
    expect(days).toEqual({ p1: ["2026-11-12", "2026-11-13", "2026-11-16"], p2: ["2026-11-14"] });
  });

  it("merges searches without repeats and keeps the earliest days", () => {
    expect(
      mergeFreeDays([{ p1: ["2026-11-14", "2026-11-15"] }, { p1: ["2026-11-12", "2026-11-14"], p2: ["2026-11-13"] }], 2),
    ).toEqual({ p1: ["2026-11-12", "2026-11-14"], p2: ["2026-11-13"] });
  });

  it("covers everyone at each location with the fewest searches", () => {
    const services = [
      { id: "s1", locationIds: ["a", "b"], practitionerIds: ["p1"] },
      { id: "s2", locationIds: ["a"], practitionerIds: ["p1", "p2", "p3"] },
      { id: "s3", locationIds: ["a"], practitionerIds: ["p4"] },
      { id: "s4", locationIds: ["b"], practitionerIds: [] },
    ];
    expect(freeDayQueries(services, [{ id: "a" }, { id: "b" }, { id: "c" }])).toEqual([
      { locationId: "a", serviceId: "s2" },
      { locationId: "a", serviceId: "s3" },
      { locationId: "b", serviceId: "s1" },
    ]);
  });
});

describe("search and labels", () => {
  it("matches every word, ignoring case and accents", () => {
    expect(matchesSearch("", "anything")).toBe(true);
    expect(matchesSearch("root canal", "Root canal treatment")).toBe(true);
    expect(matchesSearch("canal crown", "Root canal treatment")).toBe(false);
    expect(matchesSearch("cafe", "Café latte art")).toBe(true);
    expect(matchesSearch("asha", undefined, null, "Dr. Asha Menon")).toBe(true);
  });

  it("lists categories in the order they appear", () => {
    expect(serviceCategories([{ category: "Hair " }, { category: "Nails" }, { category: "Hair" }])).toEqual(["Hair", "Nails"]);
    expect(serviceCategories([{ category: undefined }])).toEqual([]);
  });

  it("finds the lowest numbered price", () => {
    expect(startingPrice([{ priceLabel: "₹1,200" }, { priceLabel: "Free" }, { priceLabel: "₹800" }, { priceLabel: undefined }])).toBe("₹800");
    expect(startingPrice([{ priceLabel: "Ask us" }])).toBeUndefined();
  });

  it("words a price pill without saying From twice", () => {
    expect(pricePillLabel([{ priceLabel: "₹800" }])).toBe("₹800");
    expect(pricePillLabel([{ priceLabel: "₹1,200" }, { priceLabel: "₹800" }])).toBe("From ₹800");
    expect(pricePillLabel([{ priceLabel: "From ₹1,500" }, { priceLabel: "₹2,000" }])).toBe("From ₹1,500");
    expect(pricePillLabel([{ priceLabel: "Free" }])).toBeUndefined();
    expect(lowestPrice([{ priceLabel: "₹1,200" }, { priceLabel: "₹800" }])?.value).toBe(800);
  });

  it("splits a day into a two-line chip", () => {
    const today = dayChipParts("2026-11-12", "2026-11-12", "en-IN");
    expect(today).toMatchObject({ top: "Today", day: "12" });
    // The spoken date keeps the weekday and month; punctuation between them is the locale's.
    expect(today.full).toMatch(/^Thursday,? 12 November$/);
    expect(dayChipParts("2026-11-14", "2026-11-12", "en-IN").top).toBe("Sat");
  });

  it("drops a title from a first name", () => {
    expect(firstName({ name: "Dr. Asha Menon" })).toBe("Asha");
    expect(firstName({ name: "Mira" })).toBe("Mira");
  });

  it("carries the customer's choices into the booking link", () => {
    expect(bookingHref("smile")).toBe("/book/smile");
    expect(bookingHref("smile", { service: "s 1", person: "p1", date: "2026-11-12" })).toBe("/book/smile?service=s+1&person=p1&date=2026-11-12");
  });

  it("carries a chosen time into the booking link", () => {
    expect(bookingHref("smile", { person: "p1", date: "2026-11-12", time: "2026-11-12T09:30:00.000Z" })).toBe(
      "/book/smile?person=p1&date=2026-11-12&time=2026-11-12T09%3A30%3A00.000Z",
    );
  });
});

describe("free times", () => {
  const slots = [
    { startsAt: "2026-11-12T09:00:00.000Z", practitionerId: "p1" },
    { startsAt: "2026-11-12T10:00:00.000Z", practitionerId: "p1" },
    { startsAt: "2026-11-13T09:00:00.000Z", practitionerId: "p1" },
    { startsAt: "2026-11-13T23:30:00.000Z", practitionerId: "p2" },
  ];

  it("counts each person's free times by the business's own day", () => {
    expect(freeTimesByPerson(slots, "UTC")).toEqual({ p1: { "2026-11-12": 2, "2026-11-13": 1 }, p2: { "2026-11-13": 1 } });
    expect(freeTimesByPerson(slots, "Asia/Kolkata").p2).toEqual({ "2026-11-14": 1 });
  });

  it("keeps the larger count when two searches find the same day", () => {
    expect(mergeFreeTimes([{ p1: { "2026-11-12": 2 } }, { p1: { "2026-11-12": 5, "2026-11-14": 1 }, p2: { "2026-11-13": 3 } }])).toEqual({
      p1: { "2026-11-12": 5, "2026-11-14": 1 },
      p2: { "2026-11-13": 3 },
    });
  });

  it("lists the earliest days and totals the times", () => {
    const times = { p1: { "2026-11-14": 1, "2026-11-12": 2, "2026-11-13": 4, "2026-11-16": 1 } };
    expect(freeDaysFromTimes(times, 3)).toEqual({ p1: ["2026-11-12", "2026-11-13", "2026-11-14"] });
    expect(countFreeTimes(times.p1)).toBe(8);
    expect(countFreeTimes(undefined)).toBe(0);
  });
});

describe("sortByPopularity", () => {
  const people = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }];
  it("sorts by average, then review count, then keeps the given order; unrated last", () => {
    const sorted = sortByPopularity(people, {
      b: { count: 3, average: 4.5 },
      c: { count: 10, average: 4.5 },
      d: { count: 1, average: 5 },
      e: { count: 0, average: null },
    });
    expect(sorted.map((p) => p.id)).toEqual(["d", "c", "b", "a", "e"]);
  });
  it("keeps the order with no ratings and does not mutate the input", () => {
    const copy = [...people];
    expect(sortByPopularity(people, undefined)).toEqual(people);
    expect(people).toEqual(copy);
  });
});

describe("todayStatus", () => {
  const week = [{ opens: "09:00", closes: "17:00" }, null, null, null, null, null, null];
  it("says open with the hours, or when it next opens", () => {
    expect(todayStatus(week, 0, "en-US")).toEqual({ open: true, label: "Open today · 9:00 AM – 5:00 PM" });
    expect(todayStatus(week, 2, "en-US")).toEqual({ open: false, label: "Closed today · Opens Mon 9:00 AM" });
    expect(todayStatus([null, null, null, null, null, null, null], 2, "en-US")).toEqual({ open: false, label: "Closed today" });
    expect(todayStatus(undefined, 0, "en-US")).toBeUndefined();
  });
});
