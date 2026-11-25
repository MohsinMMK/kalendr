import { describe, expect, it } from "vitest";

import { planCapture, planRecordSharedCapture, retryDelayMs, type AppointmentSnapshot, type OutboxSnapshot } from "./policy";

const now = new Date("2026-09-17T08:00:00.000Z");
const appointment: AppointmentSnapshot = {
  id: "appointment-1",
  version: 3,
  status: "booked",
  confirmationStatus: "confirmed",
  startsAt: new Date("2026-09-18T04:30:00.000Z"),
  clinicName: "Example Clinic",
  clinicTimezone: "Asia/Kolkata",
};
const event: OutboxSnapshot = {
  aggregateType: "appointment",
  aggregateId: "appointment-1",
  eventType: "appointment.confirm",
  payload: { appointmentId: "appointment-1", version: 3 },
  dedupeKey: "appointment.confirm:appointment-1:3",
};

describe("local outbox capture policy", () => {
  it("sends a quick message with the token and the clinic's local time", () => {
    const quick = { ...event, eventType: "appointment.quick_message", payload: { appointmentId: "appointment-1", version: 1, kind: "your_turn" }, dedupeKey: "quick:appointment-1:k1" };
    const turn = planCapture(quick, { ...appointment, status: "checked_in", queueNumber: 7 }, now);
    expect(turn.kind).toBe("capture");
    if (turn.kind !== "capture") return;
    expect(turn.message.templateKey).toBe("appointment.quick_message.your_turn");
    expect(turn.message.body).toBe("Example Clinic: Token 7, it's your turn. Please come to the front desk.");

    const late = planCapture({ ...quick, payload: { ...quick.payload, kind: "running_late", delayMinutes: 20 } }, appointment, now);
    expect(late.kind === "capture" && late.message.body).toMatch(/running about 20 minutes late.*at 10:00 am is still on\.$/);
  });

  it("drops a quick message once the visit has started or ended, and rejects bad ones", () => {
    const quick = { ...event, eventType: "appointment.quick_message", payload: { appointmentId: "appointment-1", version: 3, kind: "call_us" }, dedupeKey: "quick:appointment-1:k2" };
    expect(planCapture(quick, { ...appointment, visitStarted: true }, now)).toEqual({ kind: "skip", reason: "inapplicable" });
    expect(planCapture(quick, { ...appointment, status: "completed" }, now)).toEqual({ kind: "skip", reason: "inapplicable" });
    expect(planCapture({ ...quick, payload: { ...quick.payload, kind: "running_late" } }, appointment, now)).toEqual({ kind: "reject", code: "invalid_payload" });
    expect(planCapture({ ...quick, payload: { ...quick.payload, kind: "anything" } }, appointment, now)).toEqual({ kind: "reject", code: "invalid_payload" });
  });

  it("says a document is ready without naming it", () => {
    const plan = planRecordSharedCapture({
      aggregateType: "visit_record",
      aggregateId: "record-1",
      eventType: "record.shared",
      payload: { recordId: "record-1", patientId: "patient-1" },
      dedupeKey: "record.shared:record-1:1",
    }, "Example Clinic", now);
    expect(plan.kind).toBe("capture");
    if (plan.kind !== "capture") return;
    expect(plan.message.body).toBe("Example Clinic: A new document is ready. Sign in to your patient portal to see it.");
  });

  it("rejects record events it does not know", () => {
    expect(planRecordSharedCapture({ ...event, aggregateType: "visit_record", eventType: "record.other" }, "Example Clinic", now))
      .toEqual({ kind: "reject", code: "invalid_event" });
  });

  it("captures a current confirmation with a stable semantic key and clinic timezone", () => {
    const first = planCapture(event, appointment, now);
    const second = planCapture(event, appointment, now);
    expect(first.kind).toBe("capture");
    expect(second).toEqual(first);
    if (first.kind !== "capture") return;
    expect(first.message.semanticKey).toMatch(/^local:email:[a-f0-9]{64}$/);
    expect(first.message.body).toContain("Example Clinic");
    expect(first.message.body).toMatch(/18 Sep(?:t)? 2026, 10:00 am IST/);
    expect(first.message.body).not.toContain("appointment-1");
  });

  it("suppresses events for an older appointment version", () => {
    expect(planCapture(event, { ...appointment, version: 4 }, now)).toEqual({
      kind: "skip", reason: "superseded",
    });
  });

  it("suppresses a reminder after cancellation or its start time", () => {
    const reminder = { ...event, eventType: "appointment.reminder" };
    expect(planCapture(reminder, { ...appointment, status: "cancelled" }, now)).toEqual({
      kind: "skip", reason: "inapplicable",
    });
    expect(planCapture(reminder, { ...appointment, startsAt: now }, now)).toEqual({
      kind: "skip", reason: "inapplicable",
    });
  });

  it("renders a cancellation only when the current appointment is cancelled", () => {
    const cancellation = { ...event, eventType: "appointment.cancel" };
    expect(planCapture(cancellation, appointment, now)).toEqual({
      kind: "skip", reason: "inapplicable",
    });
    const result = planCapture(cancellation, { ...appointment, status: "cancelled" }, now);
    expect(result.kind).toBe("capture");
  });

  it("rejects malformed and unknown events without retrying them forever", () => {
    expect(planCapture({ ...event, payload: { appointmentId: "appointment-1", version: "3" } }, appointment, now)).toEqual({
      kind: "reject", code: "invalid_payload",
    });
    expect(planCapture({ ...event, eventType: "appointment.unknown" }, appointment, now)).toEqual({
      kind: "reject", code: "invalid_event",
    });
  });

  it("asks for a review once a visit is finished, in the business's words", () => {
    const review = { ...event, eventType: "appointment.review_request", dedupeKey: "review:appointment-1" };
    const finished = { ...appointment, status: "completed", version: 5 };
    const plan = planCapture(review, finished, now, { customer: "client", appointment: "session" });
    expect(plan.kind).toBe("capture");
    if (plan.kind !== "capture") return;
    expect(plan.message.templateKey).toBe("appointment.review_request");
    expect(plan.message.body).toBe("Example Clinic: Thanks for your session. How did it go? Open your manage link to leave a review.");
    // A later version of the booking doesn't cancel the request, but a visit that isn't finished does.
    expect(planCapture(review, { ...finished, status: "entered_in_error" }, now)).toEqual({ kind: "skip", reason: "inapplicable" });
    expect(planCapture(review, null, now)).toEqual({ kind: "skip", reason: "superseded" });
  });

  it("bounds exponential retry delays", () => {
    expect(retryDelayMs(1)).toBe(5_000);
    expect(retryDelayMs(2)).toBe(10_000);
    expect(retryDelayMs(20)).toBe(60 * 60 * 1_000);
  });

  it("tells a customer their request was declined, with the reason and the business's note, only while it is declined", () => {
    const declined = {
      ...event, eventType: "appointment.status.declined",
      payload: { appointmentId: "appointment-1", version: 3, reason: "need_information", message: "Please call us about your X-ray." },
      dedupeKey: "appointment.status.declined:appointment-1:3",
    };
    const plan = planCapture(declined, { ...appointment, status: "declined" }, now);
    expect(plan.kind).toBe("capture");
    if (plan.kind !== "capture") return;
    expect(plan.message.templateKey).toBe("appointment.status.declined");
    expect(plan.message.body).toContain("could not accept");
    expect(plan.message.body).toContain("We need more information.");
    expect(plan.message.body).toContain("Please call us about your X-ray.");
    // A request that was approved after all gets no decline notice.
    expect(planCapture(declined, { ...appointment, status: "booked" }, now)).toEqual({ kind: "skip", reason: "inapplicable" });
  });

  it("tells a customer their request closed when nobody answered", () => {
    const expired = {
      ...event, eventType: "appointment.status.expired",
      payload: { appointmentId: "appointment-1", version: 3 }, dedupeKey: "appointment.status.expired:appointment-1:3",
    };
    const plan = planCapture(expired, { ...appointment, status: "expired" }, now);
    expect(plan.kind === "capture" && plan.message.body).toContain("was not answered in time");
    expect(planCapture(expired, { ...appointment, status: "requested" }, now)).toEqual({ kind: "skip", reason: "inapplicable" });
  });

  it("asks a customer to choose a new time, with the business's note, only while the booking waits for one", () => {
    const asked = {
      ...event, eventType: "appointment.reschedule_requested",
      payload: { appointmentId: "appointment-1", version: 3, message: "The doctor is unwell." },
      dedupeKey: "appointment.reschedule_requested:appointment-1:3",
    };
    const plan = planCapture(asked, { ...appointment, status: "reschedule_requested" }, now);
    expect(plan.kind).toBe("capture");
    if (plan.kind !== "capture") return;
    expect(plan.message.templateKey).toBe("appointment.reschedule_requested");
    expect(plan.message.body).toContain("Please choose a new time");
    expect(plan.message.body).toContain("The doctor is unwell.");
    expect(planCapture(asked, { ...appointment, status: "booked" }, now)).toEqual({ kind: "skip", reason: "inapplicable" });
  });
});
