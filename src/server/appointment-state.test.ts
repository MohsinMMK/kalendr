import { describe, expect, it } from "vitest";

import {
  canTransitionAppointment,
  isManageableAppointment,
} from "@/server/appointment-state";

describe("appointment state policy", () => {
  it("allows the normal operational path", () => {
    expect(canTransitionAppointment("requested", "booked")).toBe(true);
    expect(canTransitionAppointment("booked", "checked_in")).toBe(true);
    expect(canTransitionAppointment("checked_in", "completed")).toBe(true);
  });

  it("does not reopen terminal records", () => {
    expect(canTransitionAppointment("cancelled", "booked")).toBe(false);
    expect(canTransitionAppointment("entered_in_error", "booked")).toBe(false);
  });

  it("limits online management to requested and booked appointments", () => {
    expect(isManageableAppointment("requested")).toBe(true);
    expect(isManageableAppointment("booked")).toBe(true);
    expect(isManageableAppointment("checked_in")).toBe(false);
  });
});

describe("request decisions (feature 41)", () => {
  it("lets a request be approved, declined, expired or cancelled", () => {
    for (const next of ["booked", "declined", "expired", "cancelled", "entered_in_error"] as const) {
      expect(canTransitionAppointment("requested", next)).toBe(true);
    }
  });

  it("allows nothing out of a declined or expired request", () => {
    for (const from of ["declined", "expired"] as const) {
      for (const next of ["requested", "booked", "checked_in", "completed", "cancelled", "no_show", "entered_in_error"] as const) {
        expect(canTransitionAppointment(from, next)).toBe(false);
      }
    }
  });

  it("does not let a booked visit be declined or expired", () => {
    expect(canTransitionAppointment("booked", "declined")).toBe(false);
    expect(canTransitionAppointment("booked", "expired")).toBe(false);
  });

  it("keeps declined and expired requests out of customer management", () => {
    expect(isManageableAppointment("declined")).toBe(false);
    expect(isManageableAppointment("expired")).toBe(false);
  });
});

describe("cancel and reschedule moves (feature 42)", () => {
  it("lets staff ask a booked visit to move, and nothing else", () => {
    expect(canTransitionAppointment("booked", "reschedule_requested")).toBe(true);
    for (const from of ["requested", "checked_in", "completed", "cancelled", "no_show", "declined", "expired"] as const) {
      expect(canTransitionAppointment(from, "reschedule_requested")).toBe(false);
    }
  });

  it("lets the customer answer a move request by booking, or the business cancel it, but not skip ahead", () => {
    expect(canTransitionAppointment("reschedule_requested", "booked")).toBe(true);
    expect(canTransitionAppointment("reschedule_requested", "cancelled")).toBe(true);
    expect(canTransitionAppointment("reschedule_requested", "checked_in")).toBe(false);
    expect(canTransitionAppointment("reschedule_requested", "completed")).toBe(false);
    expect(canTransitionAppointment("reschedule_requested", "no_show")).toBe(false);
  });

  it("keeps a visit waiting for a new time manageable from the customer's link", () => {
    expect(isManageableAppointment("reschedule_requested")).toBe(true);
  });
});
