import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildServiceSetup, slugify, type ServiceRowForSetup } from "./services-admin";

const row: ServiceRowForSetup = {
  id: "svc", name: "Haircut", description: "A cut", category: null, booking_mode: "instant",
  required_resource_kind: null, is_active: true, visibility: "listed", slug: "haircut", schedule_id: null, restriction_schedule_id: null, version: 3,
  duration_minutes: 30, price_minor: 50_000, buffer_before_minutes: 0, buffer_after_minutes: 10,
  slot_interval_minutes: null, minimum_lead_minutes: 1_440, maximum_advance_days: 30,
  booking_window_kind: "business_days", booking_window_from: null, booking_window_through: null,
  start_offset_minutes: 5, color_light: "blue", color_dark: null, banner_media_id: null,
  layouts_enabled: ["month", "week", "column"], default_layout: "month", lock_timezone: false, week_start: null,
  after_booking: "kalendr_page", redirect_url: null, pass_details_on_redirect: false, success_message: null, hide_success_details: false,
  allow_guests: false, max_guests: 3, contact_mode: "email_or_phone", verify_email: false, approval_rule: "never", approval_notice_hours: 24, requests_hold_slot: true, hide_location_until_confirmed: false, allow_customer_cancel: true, allow_customer_reschedule: true, cancel_cutoff_minutes: 0, reschedule_cutoff_minutes: 0, reschedule_same_person: true, reschedule_request_days: 7,
};

describe("slugify", () => {
  it("makes link-safe names", () => {
    expect(slugify("Hair Colour & Gloss!")).toBe("hair-colour-gloss");
    expect(slugify("Café  crème")).toBe("cafe-creme");
    expect(slugify("!!!")).toBe("service");
  });
});

describe("buildServiceSetup", () => {
  it("falls back to the service's own length and branches when no rows exist yet", () => {
    const setup = buildServiceSetup(row, [], [], ["loc1"], ["p1"]);
    expect(setup.lengths).toEqual([{ minutes: 30, priceMinor: 50_000, isDefault: true }]);
    expect(setup.locationOptions).toEqual([{ kind: "in_person", locationId: "loc1", note: null }]);
    expect(setup.timing).toMatchObject({ minimumNoticeMinutes: 1_440, slotIntervalMinutes: null, startOffsetMinutes: 5, window: { kind: "business_days", days: 30 } });
    expect(setup.version).toBe(3);
    expect(setup.bookingPage).toEqual({ layoutsEnabled: ["month", "week", "column"], defaultLayout: "month", lockTimezone: false, weekStart: null });
  });

  it("reads the booking page choices in a fixed order and ignores unknown layouts", () => {
    const setup = buildServiceSetup({ ...row, layouts_enabled: ["week", "bogus", "month"], default_layout: "week", lock_timezone: true, week_start: 7 }, [], [], ["loc1"], []);
    expect(setup.bookingPage).toEqual({ layoutsEnabled: ["month", "week"], defaultLayout: "week", lockTimezone: true, weekStart: 7 });
  });

  it("reads a date range window and orders lengths", () => {
    const setup = buildServiceSetup(
      { ...row, booking_window_kind: "date_range", booking_window_from: "2026-12-01", booking_window_through: "2026-12-31" },
      [{ minutes: 60, price_minor: 90_000, is_default: false, sort_order: 1 }, { minutes: 30, price_minor: 50_000, is_default: true, sort_order: 0 }],
      [{ kind: "video", location_id: null, note: null, sort_order: 0 }], ["loc1"], [],
    );
    expect(setup.timing.window).toEqual({ kind: "date_range", from: "2026-12-01", through: "2026-12-31" });
    expect(setup.lengths.map((length) => length.minutes)).toEqual([30, 60]);
    expect(setup.locationOptions).toEqual([{ kind: "video", locationId: null, note: null }]);
  });
});
