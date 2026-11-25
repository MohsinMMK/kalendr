import { describe, expect, it } from "vitest";

import { activeRouteFor, isBoundedPath } from "./active-route";

describe("activeRouteFor", () => {
  it("names the sidebar place from the first part of the address", () => {
    expect(activeRouteFor("/bookings", null)).toBe("bookings");
    expect(activeRouteFor("/routing-forms", null)).toBe("routing-forms");
    expect(activeRouteFor("/profile/notifications", null)).toBe("profile");
  });

  it("marks the pages that moved out of Settings as their own places", () => {
    expect(activeRouteFor("/reviews", null)).toBe("reviews");
    expect(activeRouteFor("/spam", null)).toBe("spam");
    expect(activeRouteFor("/activity", null)).toBe("activity");
  });

  it("keeps settings under the dashboard", () => {
    expect(activeRouteFor("/settings", null)).toBe("dashboard");
    expect(activeRouteFor("/settings/import", null)).toBe("dashboard");
  });

  it("points an appointment back to the page it came from, as the pages did", () => {
    expect(activeRouteFor("/appointments/new", "schedule")).toBe("schedule");
    expect(activeRouteFor("/appointments/new", "patients")).toBe("dashboard");
    expect(activeRouteFor("/appointments/abc", "patients")).toBe("patients");
    expect(activeRouteFor("/appointments/abc", "bookings")).toBe("schedule");
    expect(activeRouteFor("/appointments/series/abc", "bookings")).toBe("bookings");
    expect(activeRouteFor("/appointments/series/abc", "patients")).toBe("schedule");
  });

  it("falls back to the dashboard for anything else", () => {
    expect(activeRouteFor("/", null)).toBe("dashboard");
    expect(activeRouteFor("/nowhere", null)).toBe("dashboard");
  });
});

describe("isBoundedPath", () => {
  it("fills the screen only on the calendar-style pages", () => {
    expect(["/dashboard", "/schedule", "/bookings"].every(isBoundedPath)).toBe(true);
    expect(isBoundedPath("/settings")).toBe(false);
    expect(isBoundedPath("/patients")).toBe(false);
    expect(isBoundedPath("/settings/import")).toBe(false);
  });
});
