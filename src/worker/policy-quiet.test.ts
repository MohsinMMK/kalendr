import { describe, expect, it } from "vitest";

import { planCapture, type AppointmentSnapshot, type OutboxSnapshot } from "./policy";

const appointment: AppointmentSnapshot = {
  id: "appointment-1", version: 1, status: "booked", confirmationStatus: "confirmed",
  startsAt: new Date("2030-09-18T04:30:00.000Z"), clinicName: "Example Clinic", clinicTimezone: "Asia/Kolkata",
};
const created = (payload: Record<string, unknown>): OutboxSnapshot => ({
  aggregateType: "appointment", aggregateId: "appointment-1", eventType: "appointment.created",
  payload: { appointmentId: "appointment-1", version: 1, ...payload }, dedupeKey: "appointment.created:appointment-1:1",
});

describe("changes queued without telling the customer (an import, feature 12)", () => {
  const now = new Date("2026-09-17T08:00:00.000Z");

  it("still sends the confirmation by default", () => {
    expect(planCapture(created({}), appointment, now).kind).toBe("capture");
  });

  it("sends nothing when the change says notifyCustomer is false", () => {
    expect(planCapture(created({ notifyCustomer: false }), appointment, now)).toEqual({ kind: "skip", reason: "no_message" });
    expect(planCapture({ ...created({ notifyCustomer: false }), eventType: "appointment.status.cancelled" }, { ...appointment, status: "cancelled" }, now))
      .toEqual({ kind: "skip", reason: "no_message" });
  });
});
