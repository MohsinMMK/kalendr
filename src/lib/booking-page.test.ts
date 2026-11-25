import { describe, expect, it } from "vitest";

import {
  bookingPageSettingsSchema, chooseLayout, layoutForWidth, resolveHour12, timeZoneNotice, weekStartsOn, zoneOffsetMinutes,
} from "./booking-page";

const winter = new Date("2026-01-15T12:00:00Z");

describe("time zones", () => {
  it("measures offsets, including the half hours", () => {
    expect(zoneOffsetMinutes("Asia/Kolkata", winter)).toBe(330);
    expect(zoneOffsetMinutes("Asia/Dubai", winter)).toBe(240);
    expect(zoneOffsetMinutes("Europe/London", new Date("2026-07-15T12:00:00Z"))).toBe(60);
  });

  it("says how far a visitor in Dubai is from a clinic in India", () => {
    expect(timeZoneNotice("Asia/Dubai", "Asia/Kolkata", "clinic", winter)).toBe("Times shown in Dubai time (1 h 30 m behind the clinic).");
    expect(timeZoneNotice("Asia/Kolkata", "Asia/Dubai", "salon", winter)).toBe("Times shown in Kolkata time (1 h 30 m ahead of the salon).");
  });

  it("stays quiet when the zones are the same", () => {
    expect(timeZoneNotice("Asia/Kolkata", "Asia/Kolkata", "clinic", winter)).toBeNull();
    expect(timeZoneNotice("Asia/Calcutta", "Asia/Kolkata", "clinic", winter)).toBeNull();
  });

  it("reads the offset on the day, so a clock change is counted", () => {
    expect(timeZoneNotice("Europe/London", "Asia/Kolkata", "clinic", new Date("2026-07-15T12:00:00Z"))).toBe("Times shown in London time (4 h 30 m behind the clinic).");
    expect(timeZoneNotice("Europe/London", "Asia/Kolkata", "clinic", winter)).toBe("Times shown in London time (5 h 30 m behind the clinic).");
  });
});

describe("clock and week start", () => {
  it("forces 12 or 24 hours and otherwise follows the locale", () => {
    expect(resolveHour12("12h", "en-GB")).toBe(true);
    expect(resolveHour12("24h", "en-US")).toBe(false);
    expect(resolveHour12("auto", "en-US")).toBe(true);
    expect(resolveHour12("auto", "en-GB")).toBe(false);
  });

  it("follows the service, then the business", () => {
    expect(weekStartsOn(7)).toBe(0);
    expect(weekStartsOn(1, 7)).toBe(1);
    expect(weekStartsOn(null, 7)).toBe(0);
    expect(weekStartsOn(null)).toBe(1);
  });
});

describe("layouts", () => {
  const settings = { layoutsEnabled: ["month", "week"] as const, defaultLayout: "month" as const };
  it("honours the link only when the service allows that layout", () => {
    expect(chooseLayout("week", { ...settings, layoutsEnabled: [...settings.layoutsEnabled] })).toBe("week");
    expect(chooseLayout("column", { ...settings, layoutsEnabled: [...settings.layoutsEnabled] })).toBe("month");
    expect(chooseLayout(null, { ...settings, layoutsEnabled: [...settings.layoutsEnabled] })).toBe("month");
  });

  it("falls back to month on a phone", () => {
    expect(layoutForWidth("week", true)).toBe("month");
    expect(layoutForWidth("week", false)).toBe("week");
  });

  it("will not save a default that is not allowed", () => {
    expect(bookingPageSettingsSchema.safeParse({ layoutsEnabled: ["week"], defaultLayout: "month", lockTimezone: false, weekStart: null }).success).toBe(false);
    expect(bookingPageSettingsSchema.safeParse({ layoutsEnabled: [], defaultLayout: "month", lockTimezone: false, weekStart: null }).success).toBe(false);
  });
});
