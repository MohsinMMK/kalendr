/** @vitest-environment node */

import { describe, expect, it } from "vitest";

import { closedHolidayDates, holidayCountries, holidayRegions, listHolidays, suggestCountry } from "./holidays";

const none = { optedOut: {}, customDays: [] };

describe("public holidays", () => {
  it("lists a country's public holidays for a range, with the id that stays the same each year", () => {
    const { items, ok } = listHolidays({ country: "IN", region: null, ...none }, "2026-01-01", "2026-12-31");
    expect(ok).toBe(true);
    const republic = items.find((item) => item.name === "Republic Day");
    expect(republic).toMatchObject({ date: "2026-01-26", id: "01-26", type: "public", closed: true });
    expect(listHolidays({ country: "IN", region: null, ...none }, "2027-01-01", "2027-12-31").items.find((item) => item.name === "Republic Day")?.id).toBe("01-26");
  });

  it("keeps the business open on a holiday the owner turned off, for that year only", () => {
    const settings = { country: "TT", region: null, optedOut: { "2026": ["2026-11-08"] }, customDays: [] };
    const deepavali = listHolidays(settings, "2026-11-01", "2026-11-30").items.filter((item) => item.name === "Deepavali");
    expect(deepavali.map((item) => [item.date, item.closed])).toEqual([["2026-11-08", false], ["2026-11-09", true]]);
    expect(closedHolidayDates(settings, "2026-11-01", "2026-11-30")).toEqual([{ date: "2026-11-09", name: "Deepavali" }]);
  });

  it("adds the owner's own closed days, for festivals the data does not list", () => {
    const settings = { country: "IN", region: null, optedOut: {}, customDays: [{ date: "2026-11-08", name: "Diwali" }] };
    expect(closedHolidayDates(settings, "2026-11-01", "2026-11-30")).toEqual([{ date: "2026-11-08", name: "Diwali" }]);
  });

  it("closes nothing when holidays are not turned on", () => {
    expect(closedHolidayDates(null, "2026-01-01", "2026-12-31")).toEqual([]);
  });

  it("does not fail the page for a country whose data cannot be read", () => {
    const result = listHolidays({ country: "SG", region: null, ...none }, "2026-01-01", "2026-12-31");
    expect(typeof result.ok).toBe("boolean");
    expect(Array.isArray(result.items)).toBe(true);
  });

  it("lists countries and regions and suggests a country from a timezone", () => {
    expect(holidayCountries().find((country) => country.code === "IN")?.name).toBe("India");
    expect(holidayRegions("IN").some((region) => region.code === "MH")).toBe(true);
    expect(suggestCountry("Asia/Kolkata")).toBe("IN");
    expect(suggestCountry("Not/AZone")).toBeNull();
  });
});
