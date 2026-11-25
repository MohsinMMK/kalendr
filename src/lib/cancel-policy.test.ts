import { describe, expect, it } from "vitest";

import { cancellationDeadline, cutoffWords, customerCancelDecision, customerRescheduleDecision, defaultCancelPolicy, policyMessage } from "./cancel-policy";

const startsAt = new Date("2026-12-10T10:00:00.000Z");
const hoursBefore = (hours: number) => new Date(startsAt.getTime() - hours * 3_600_000);
const policy = { ...defaultCancelPolicy, cancelCutoffMinutes: 12 * 60, rescheduleCutoffMinutes: 24 * 60 };

describe("customer cancel and reschedule policy", () => {
  it("lets a customer cancel up to the cut-off and not after it", () => {
    expect(customerCancelDecision(policy, startsAt, hoursBefore(13))).toMatchObject({ allowed: true, reason: null });
    expect(customerCancelDecision(policy, startsAt, hoursBefore(12))).toMatchObject({ allowed: true });
    expect(customerCancelDecision(policy, startsAt, hoursBefore(11))).toMatchObject({ allowed: false, reason: "inside_cutoff" });
  });

  it("holds reschedule to its own cut-off", () => {
    expect(customerRescheduleDecision(policy, startsAt, hoursBefore(25)).allowed).toBe(true);
    expect(customerRescheduleDecision(policy, startsAt, hoursBefore(23)).allowed).toBe(false);
  });

  it("places no limit when the cut-off is zero", () => {
    expect(customerCancelDecision(defaultCancelPolicy, startsAt, hoursBefore(0.01))).toEqual({ allowed: true, reason: null, cutoffAt: null });
    expect(cancellationDeadline(defaultCancelPolicy, startsAt)).toBeNull();
  });

  it("refuses when the business switched the action off, whatever the time", () => {
    expect(customerCancelDecision({ ...defaultCancelPolicy, allowCustomerCancel: false }, startsAt, hoursBefore(500))).toMatchObject({ allowed: false, reason: "disabled" });
    expect(customerRescheduleDecision({ ...defaultCancelPolicy, allowCustomerReschedule: false }, startsAt, hoursBefore(500))).toMatchObject({ allowed: false, reason: "disabled" });
  });

  it("exposes the free-cancellation deadline for payments to read", () => {
    expect(cancellationDeadline(policy, startsAt)?.toISOString()).toBe(hoursBefore(12).toISOString());
  });

  it("says the rule in plain words with the business's phone", () => {
    const inside = customerCancelDecision(policy, startsAt, hoursBefore(2));
    expect(policyMessage("cancel", inside, policy, "+91 99999 00000")).toBe("It can't be cancelled online within 12 hours of the start. Please call +91 99999 00000.");
    const off = customerRescheduleDecision({ ...policy, allowCustomerReschedule: false }, startsAt, hoursBefore(2));
    expect(policyMessage("reschedule", off, { ...policy, allowCustomerReschedule: false }, null)).toBe("This booking can't be moved online. Please contact the business.");
    expect(cutoffWords(1440)).toBe("1 day");
    expect(cutoffWords(90)).toBe("90 minutes");
    expect(cutoffWords(60)).toBe("1 hour");
  });
});
