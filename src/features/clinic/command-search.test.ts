import { describe, expect, it } from "vitest";

import { matchesQuery, parseDateQuery } from "./command-search";

// Thursday, 12 November 2026.
const today = "2026-11-12";

describe("jumping to a date from the palette", () => {
  it("understands today, tomorrow and yesterday", () => {
    expect(parseDateQuery("today", today)).toBe("2026-11-12");
    expect(parseDateQuery("Tomorrow", today)).toBe("2026-11-13");
    expect(parseDateQuery("yesterday", today)).toBe("2026-11-11");
  });

  it("understands a full date", () => {
    expect(parseDateQuery("2026-12-01", today)).toBe("2026-12-01");
    expect(parseDateQuery("2026-02-31", today)).toBeNull();
  });

  it("finds the next time a weekday comes round, never today", () => {
    expect(parseDateQuery("monday", today)).toBe("2026-11-16");
    expect(parseDateQuery("next mon", today)).toBe("2026-11-16");
    expect(parseDateQuery("thursday", today)).toBe("2026-11-19");
  });

  it("understands a day and month either way round", () => {
    expect(parseDateQuery("16 nov", today)).toBe("2026-11-16");
    expect(parseDateQuery("Nov 16", today)).toBe("2026-11-16");
    expect(parseDateQuery("16th november 2027", today)).toBe("2027-11-16");
    expect(parseDateQuery("3 oct", today)).toBe("2026-10-03");
  });

  it("reads a date well in the past as next year's", () => {
    expect(parseDateQuery("5 jan", today)).toBe("2027-01-05");
  });

  it("understands a number of days or weeks ahead", () => {
    expect(parseDateQuery("in 3 days", today)).toBe("2026-11-15");
    expect(parseDateQuery("2w", today)).toBe("2026-11-26");
  });

  it("says nothing for text that is not a date, such as a name or a phone number", () => {
    expect(parseDateQuery("asha rao", today)).toBeNull();
    expect(parseDateQuery("98765", today)).toBeNull();
    expect(parseDateQuery("31 feb", today)).toBeNull();
    expect(parseDateQuery("", today)).toBeNull();
  });
});

describe("matching the palette's own entries", () => {
  it("needs every word, in any order, ignoring case", () => {
    expect(matchesQuery("New appointment", "new appt")).toBe(false);
    expect(matchesQuery("New appointment", "appointment new")).toBe(true);
    expect(matchesQuery("Settings", "SET")).toBe(true);
    expect(matchesQuery("Settings", "")).toBe(true);
  });
});
