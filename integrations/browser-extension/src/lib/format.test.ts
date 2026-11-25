import { describe, expect, it } from "vitest";

import { bookingLine, dayLabel, matches, tidyKey, timeIn, timesAsText } from "./format";

describe("popup text", () => {
  it("shows times in the business's time zone, not the browser's", () => {
    expect(timeIn("2026-12-01T04:00:00.000Z", "Asia/Kolkata").toLowerCase()).toContain("9:30");
    expect(timeIn("2026-12-01T04:00:00.000Z", "America/New_York").toLowerCase()).toContain("11:00");
    expect(timeIn("2026-12-01T04:00:00.000Z", "Not/AZone")).toMatch(/\d/);
  });

  it("names the day and the status in words", () => {
    expect(dayLabel("2026-12-01", "Asia/Kolkata")).toContain("December");
    expect(bookingLine({ id: "a", startsAt: "2026-12-01T04:00:00.000Z", endsAt: "2026-12-01T04:30:00.000Z", status: "checked_in", serviceName: "Cleaning", firstName: "Asha" }, "Asia/Kolkata"))
      .toMatchObject({ who: "Asha", what: "Cleaning", status: "Arrived" });
    expect(bookingLine({ id: "a", startsAt: "2026-12-01T04:00:00.000Z", endsAt: "2026-12-01T04:30:00.000Z", status: "weird", serviceName: "X", firstName: "Y" }, "UTC").status).toBe("Booked");
  });

  it("writes the plain-text twin of the email times", () => {
    expect(timesAsText("Cleaning", [{ label: "Tue 9:30 am", href: "https://k/a" }], "https://k/book")).toBe("Times for Cleaning:\n- Tue 9:30 am: https://k/a\nMore times: https://k/book");
  });

  it("cleans a pasted key and searches without caring about case", () => {
    expect(tidyKey(" kal_live_abc \n def ")).toBe("kal_live_abcdef");
    expect(matches("Dental Cleaning", " clean ")).toBe(true);
    expect(matches("Dental Cleaning", "root")).toBe(false);
  });
});
