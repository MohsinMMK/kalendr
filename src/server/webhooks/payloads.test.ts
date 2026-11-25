import { describe, expect, it } from "vitest";

import { webhookEventTypes } from "@/lib/api-scopes";
import { classifyStatus } from "./transport";
import { defaultWebhookPolicy, maxAttempts, retryDelayAfter } from "@/worker/webhooks/policy";
import { envelope, eventIdFor, publicEventFor, testEnvelope, webhookEnvelopeSchema } from "./payloads";

describe("outbox to public event mapping", () => {
  it.each([
    ["appointment.created", "appointment.created:a:1", "appointment.created"],
    ["appointment.reschedule", "appointment.reschedule:a:2", "appointment.rescheduled"],
    ["appointment.cancel", "appointment.cancel:a:3", "appointment.cancelled"],
    ["appointment.status.cancelled", "appointment.status.cancelled:a:3", "appointment.cancelled"],
    ["appointment.status.completed", "x", "appointment.completed"],
    ["appointment.status.no_show", "x", "appointment.no_show"],
    ["customer.created", "customer.created:c", "customer.created"],
    ["payment.captured", "payment.captured:p", "payment.captured"],
  ])("%s becomes %s", (type, key, expected) => {
    expect(publicEventFor(type, key)).toBe(expected);
  });

  it("sends nothing for reschedule offers or events with no public name", () => {
    expect(publicEventFor("appointment.created", "appointment.reschedule_offer:a:2:99")).toBeNull();
    for (const type of ["appointment.confirm", "appointment.suggest", "appointment.status.checked_in", "appointment.status.booked", "appointment.reminder", "appointment.status.requested", "push.send", "webhook.deliver"]) {
      expect(publicEventFor(type, "k")).toBeNull();
    }
  });

  it("every public event has a source", () => {
    const produced = new Set(["appointment.created", "appointment.reschedule", "appointment.cancel", "appointment.status.completed", "appointment.status.no_show", "customer.created", "payment.captured"].map((type) => publicEventFor(type, "k")));
    for (const type of webhookEventTypes) expect(produced.has(type)).toBe(true);
  });
});

describe("envelopes", () => {
  it("builds the documented envelope and keeps names out", () => {
    const data = { appointmentId: "a", status: "booked", startsAt: "2027-01-01T10:00:00.000Z", endsAt: "2027-01-01T10:30:00.000Z", serviceId: "s", staffId: "p", customerId: "c", locationId: "l", version: 3 };
    const built = envelope("evt_1", "appointment.created", { ...data, firstName: "Asha", phone: "+91" }, new Date("2026-11-19T00:00:00Z"));
    expect(built).toEqual({ id: "evt_1", type: "appointment.created", apiVersion: "v1", createdAt: "2026-11-19T00:00:00.000Z", data });
  });

  it("rejects data of the wrong shape and has a test event", () => {
    expect(() => envelope("e", "customer.created", {}, new Date())).toThrow();
    expect(webhookEnvelopeSchema.parse(testEnvelope("evt_t", new Date())).data).toEqual({ message: "This is a test event from Kalendr." });
  });

  it("gives one id for one change however many times it is asked", () => {
    expect(eventIdFor(["appointment.cancelled", "a", "3"])).toBe(eventIdFor(["appointment.cancelled", "a", "3"]));
    expect(eventIdFor(["appointment.cancelled", "a", "3"])).not.toBe(eventIdFor(["appointment.cancelled", "a", "4"]));
    expect(eventIdFor(["appointment.cancelled", "a", "3"])).toMatch(/^evt_[0-9a-f]{32}$/);
  });
});

describe("delivery policy", () => {
  it("retries on the documented schedule for about 22 hours over 8 attempts", () => {
    const minutes = defaultWebhookPolicy.retryDelaysMs.map((ms) => ms / 60_000);
    expect(minutes).toEqual([1, 5, 20, 60, 180, 360, 720]);
    expect(maxAttempts(defaultWebhookPolicy)).toBe(8);
    expect(minutes.reduce((a, b) => a + b, 0) / 60).toBeCloseTo(22.4, 1);
    expect(retryDelayAfter(defaultWebhookPolicy, 1)).toBe(60_000);
    expect(retryDelayAfter(defaultWebhookPolicy, 7)).toBe(12 * 3_600_000);
    expect(retryDelayAfter(defaultWebhookPolicy, 8)).toBeNull();
    expect(defaultWebhookPolicy.disableAfterFailures).toBe(12);
    expect(defaultWebhookPolicy.timeoutMs).toBe(10_000);
  });

  it("counts only 2xx as success and never follows a redirect", () => {
    expect(classifyStatus(200)).toEqual({ ok: true });
    expect(classifyStatus(204)).toEqual({ ok: true });
    expect(classifyStatus(301)).toEqual({ ok: false, errorCode: "redirect_blocked" });
    expect(classifyStatus(307)).toEqual({ ok: false, errorCode: "redirect_blocked" });
    expect(classifyStatus(404)).toEqual({ ok: false, errorCode: "http_status" });
    expect(classifyStatus(500)).toEqual({ ok: false, errorCode: "http_status" });
  });
});
