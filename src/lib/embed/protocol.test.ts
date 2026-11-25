import { describe, expect, it } from "vitest";

import { embedEventNames, parseEmbedEvent } from "./protocol";

describe("embed events", () => {
  it("knows exactly the seven events the host page can hear", () => {
    expect([...embedEventNames]).toEqual(["opened", "service_selected", "slot_selected", "booked", "rescheduled", "cancelled", "failed"]);
  });

  it("keeps ids and times and drops anything else, so a name or phone can never reach the host page", () => {
    const parsed = parseEmbedEvent("booked", {
      appointmentId: "appt_123", serviceId: "svc-1", startsAt: "2026-12-01T10:00:00.000Z", endsAt: "2026-12-01T10:30:00.000Z", status: "booked",
      firstName: "Asha", email: "asha@example.com", phone: "+919800000000", notes: "knee pain",
    });
    expect(parsed).toEqual({
      event: "booked",
      data: { appointmentId: "appt_123", serviceId: "svc-1", startsAt: "2026-12-01T10:00:00.000Z", endsAt: "2026-12-01T10:30:00.000Z", status: "booked" },
    });
    expect(JSON.stringify(parsed)).not.toMatch(/Asha|asha@|9800|knee/);
  });

  it("refuses an unknown event, a malformed id and a time that is not a time", () => {
    expect(parseEmbedEvent("exploded", {})).toBeNull();
    expect(parseEmbedEvent("booked", { appointmentId: "has spaces and <script>" })).toBeNull();
    expect(parseEmbedEvent("slot_selected", { startsAt: "tomorrow at noon" })).toBeNull();
    expect(parseEmbedEvent("failed", { reason: "Asha was rude" })).toBeNull();
  });

  it("accepts an event with no data", () => {
    expect(parseEmbedEvent("opened", undefined)).toEqual({ event: "opened", data: {} });
  });
});
