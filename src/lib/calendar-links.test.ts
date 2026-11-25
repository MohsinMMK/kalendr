import { describe, expect, it } from "vitest";

import { bookingCalendarEvent, calendarFileHref, googleCalendarHref, outlookComHref } from "./calendar-links";

const event = bookingCalendarEvent({
  serviceName: "Cleaning & check-up",
  businessName: "Smile Dental",
  startsAt: "2026-11-12T10:00:00+05:30",
  endsAt: "2026-11-12T10:45:00+05:30",
  personName: "Dr. Asha Menon",
  location: { name: "Indiranagar", address: "12 100 Feet Rd", city: "Bengaluru" },
  manageUrl: "https://kalendr.app/manage/abc123",
  manageLabel: "Manage appointment",
});

describe("calendar links", () => {
  it("builds the event in the business's words", () => {
    expect(event).toEqual({
      title: "Cleaning & check-up at Smile Dental",
      startsAt: "2026-11-12T10:00:00+05:30",
      endsAt: "2026-11-12T10:45:00+05:30",
      location: "Indiranagar, 12 100 Feet Rd, Bengaluru",
      details: "With Dr. Asha Menon\nManage appointment: https://kalendr.app/manage/abc123",
    });
  });

  it("opens Google Calendar with UTC times", () => {
    const url = new URL(googleCalendarHref(event));
    expect(url.origin + url.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("text")).toBe("Cleaning & check-up at Smile Dental");
    expect(url.searchParams.get("dates")).toBe("20261112T043000Z/20261112T051500Z");
    expect(url.searchParams.get("location")).toBe("Indiranagar, 12 100 Feet Rd, Bengaluru");
    expect(url.searchParams.get("details")).toContain("https://kalendr.app/manage/abc123");
  });

  it("opens Outlook.com with ISO times", () => {
    const url = new URL(outlookComHref(event));
    expect(url.hostname).toBe("outlook.live.com");
    expect(url.searchParams.get("rru")).toBe("addevent");
    expect(url.searchParams.get("subject")).toBe("Cleaning & check-up at Smile Dental");
    expect(url.searchParams.get("startdt")).toBe("2026-11-12T04:30:00.000Z");
    expect(url.searchParams.get("enddt")).toBe("2026-11-12T05:15:00.000Z");
    expect(url.searchParams.get("body")).toContain("With Dr. Asha Menon");
  });

  it("leaves out what it doesn't know", () => {
    const bare = bookingCalendarEvent({ serviceName: "Haircut", businessName: "Fade", startsAt: "2026-11-12T10:00:00Z", endsAt: "2026-11-12T10:30:00Z" });
    expect(bare).not.toHaveProperty("location");
    expect(bare).not.toHaveProperty("details");
    expect(new URL(googleCalendarHref(bare)).searchParams.has("location")).toBe(false);
  });

  it("points at the calendar file for a booking", () => {
    expect(calendarFileHref("a b")).toBe("/api/public/appointments/a%20b/calendar");
  });
});
