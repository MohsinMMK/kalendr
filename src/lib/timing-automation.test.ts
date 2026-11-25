import { describe, expect, it } from "vitest";

import { bookedOnWebsite, notificationChannel } from "./notification-routing";
import { pickNearestSlot, timingSummary } from "./timing-automation";

describe("pickNearestSlot", () => {
  const slot = (startsAt: string) => ({ startsAt });

  it("returns the closest opening", () => {
    expect(pickNearestSlot("2026-09-01T15:00:00+05:30", [slot("2026-09-01T09:00:00+05:30"), slot("2026-09-01T13:30:00+05:30"), slot("2026-09-02T09:00:00+05:30")])?.startsAt).toBe("2026-09-01T13:30:00+05:30");
  });

  it("prefers the later opening on a tie so nobody is asked to come early", () => {
    expect(pickNearestSlot("2026-09-01T12:00:00+05:30", [slot("2026-09-01T11:00:00+05:30"), slot("2026-09-01T13:00:00+05:30")])?.startsAt).toBe("2026-09-01T13:00:00+05:30");
  });

  it("returns null when there is nothing to offer", () => {
    expect(pickNearestSlot("2026-09-01T12:00:00+05:30", [])).toBeNull();
  });
});

describe("timingSummary", () => {
  it("says plainly when nothing was affected", () => {
    expect(timingSummary({ moved: [], unresolved: [] })).toBe("No bookings were affected.");
  });

  it("reports moved and stuck visits separately", () => {
    expect(timingSummary({ moved: [{ appointmentId: "a", from: "x", to: "y" }], unresolved: ["b", "c"] })).toBe("1 booking moved, patient update queued. 2 need a person in Messages.");
  });
});

describe("notificationChannel", () => {
  it("follows the customer's choice once they agreed to messages, whatever the booking source", () => {
    expect(bookedOnWebsite("widget")).toBe(true);
    expect(notificationChannel("online", "whatsapp")).toBe("whatsapp");
    expect(notificationChannel("widget", "sms")).toBe("sms");
    expect(notificationChannel("staff", "whatsapp")).toBe("whatsapp");
    expect(notificationChannel("recall", "phone")).toBe("sms");
  });

  it("uses email without consent or when email is what they asked for", () => {
    expect(notificationChannel("online", "whatsapp", false)).toBe("email");
    expect(notificationChannel("staff", "phone", false)).toBe("email");
    expect(notificationChannel("staff", "email")).toBe("email");
  });

  it("falls back from WhatsApp to SMS to email by what is switched on", () => {
    expect(notificationChannel("staff", "whatsapp", true, { whatsapp: false, sms: true })).toBe("sms");
    expect(notificationChannel("staff", "whatsapp", true, { whatsapp: false, sms: false })).toBe("email");
    expect(notificationChannel("staff", "phone", true, { whatsapp: true, sms: false })).toBe("email");
  });
});
