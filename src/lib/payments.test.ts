import { describe, expect, it } from "vitest";

import {
  amountDueNow, decideRefund, livePaymentExample, paymentAccountInputSchema, paymentPolicySchema, policyWording, servicePaymentSchema,
  type PaymentPolicy,
} from "./payments";

const policy: PaymentPolicy = { freeCancelHours: 24, afterWindowRule: "no_refund", noShowRule: "deposit", version: 1 };
const startsAt = new Date("2026-12-01T10:00:00.000Z");
const hoursBefore = (hours: number) => new Date(startsAt.getTime() - hours * 3_600_000);

describe("what is due now", () => {
  it("is the deposit for a deposit service and everything for a full one, from the service alone", () => {
    expect(amountDueNow({ mode: "deposit", priceMinor: 80000, depositMinor: 20000 })).toEqual({ dueNowMinor: 20000, dueLaterMinor: 60000 });
    expect(amountDueNow({ mode: "full", priceMinor: 80000, depositMinor: null })).toEqual({ dueNowMinor: 80000, dueLaterMinor: 0 });
    expect(amountDueNow({ mode: "none", priceMinor: 80000, depositMinor: null })).toEqual({ dueNowMinor: 0, dueLaterMinor: 80000 });
    expect(amountDueNow({ mode: "deposit", priceMinor: null, depositMinor: 20000 }).dueNowMinor).toBe(0);
  });

  it("never asks for more than the price, even when a length costs less than the deposit", () => {
    expect(amountDueNow({ mode: "deposit", priceMinor: 15000, depositMinor: 20000 })).toEqual({ dueNowMinor: 15000, dueLaterMinor: 0 });
  });

  it("shows the business a live example", () => {
    const payment = { mode: "deposit" as const, priceMinor: 80000, depositMinor: 20000, dueNowMinor: 20000, dueLaterMinor: 60000, currency: "INR" };
    expect(livePaymentExample(payment)).toBe("Customers pay ₹200 now and ₹600 at the visit.");
    expect(livePaymentExample({ ...payment, mode: "full", dueNowMinor: 80000, dueLaterMinor: 0 })).toBe("Customers pay ₹800 when they book.");
    expect(livePaymentExample({ ...payment, dueNowMinor: 0 })).toBeNull();
  });
});

describe("service pricing input", () => {
  it("needs a price, and a deposit smaller than it", () => {
    expect(servicePaymentSchema.safeParse({ priceMinor: 80000, paymentMode: "deposit", depositMinor: 20000 }).success).toBe(true);
    expect(servicePaymentSchema.safeParse({ priceMinor: null, paymentMode: "full", depositMinor: null }).success).toBe(false);
    expect(servicePaymentSchema.safeParse({ priceMinor: 80000, paymentMode: "deposit", depositMinor: 80000 }).success).toBe(false);
    expect(servicePaymentSchema.safeParse({ priceMinor: 80000, paymentMode: "deposit", depositMinor: null }).success).toBe(false);
    expect(servicePaymentSchema.safeParse({ priceMinor: null, paymentMode: "none", depositMinor: null }).success).toBe(true);
    expect(servicePaymentSchema.safeParse({ priceMinor: 80000.5, paymentMode: "full", depositMinor: null }).success).toBe(false);
  });
});

describe("policy words", () => {
  const deposit = { mode: "deposit" as const, depositMinor: 20000, dueNowMinor: 20000, currency: "INR" };
  it("says what is paid, the refund window, what happens after it and what a no-show forfeits", () => {
    const text = policyWording(policy, deposit, "appointment");
    expect(text).toContain("You pay ₹200 now as a deposit.");
    expect(text).toContain("at least 1 day before it starts for a full refund");
    expect(text).toContain("After that, there is no refund.");
    expect(text).toContain("your deposit is kept");
  });

  it("names the deposit that is kept when that is the rule", () => {
    expect(policyWording({ ...policy, afterWindowRule: "keep_deposit", freeCancelHours: 6 }, deposit)).toContain("your ₹200 deposit is kept and anything you paid beyond it is refunded");
  });

  it("says nothing when no payment is asked for", () => {
    expect(policyWording(policy, { ...deposit, dueNowMinor: 0 })).toBe("");
  });
});

describe("what a cancellation or no-show does with the money", () => {
  const base = { policy, startsAt, paidOnlineMinor: 20000, depositMinor: 20000 };

  it("refunds everything inside the free window and nothing outside it", () => {
    expect(decideRefund({ ...base, event: "cancel", now: hoursBefore(30) })).toEqual({ action: "refund", refundMinor: 20000, keptMinor: 0 });
    expect(decideRefund({ ...base, event: "cancel", now: hoursBefore(24) }).action).toBe("refund");
    expect(decideRefund({ ...base, event: "cancel", now: hoursBefore(23) })).toEqual({ action: "keep", refundMinor: 0, keptMinor: 20000 });
  });

  it("keeps only the deposit when that is the rule, refunding what was paid beyond it", () => {
    const rule = { ...policy, afterWindowRule: "keep_deposit" as const };
    expect(decideRefund({ ...base, policy: rule, paidOnlineMinor: 50000, event: "cancel", now: hoursBefore(2) })).toEqual({ action: "refund", refundMinor: 30000, keptMinor: 20000 });
    expect(decideRefund({ ...base, policy: rule, event: "cancel", now: hoursBefore(2) })).toEqual({ action: "keep", refundMinor: 0, keptMinor: 20000 });
  });

  it("keeps the deposit on a no-show, or everything when the policy says so", () => {
    expect(decideRefund({ ...base, event: "no_show", now: hoursBefore(-1) })).toEqual({ action: "keep", refundMinor: 0, keptMinor: 20000 });
    expect(decideRefund({ ...base, paidOnlineMinor: 50000, event: "no_show", now: hoursBefore(-1) })).toEqual({ action: "keep", refundMinor: 30000, keptMinor: 20000 });
    expect(decideRefund({ ...base, paidOnlineMinor: 50000, policy: { ...policy, noShowRule: "everything" }, event: "no_show", now: hoursBefore(-1) })).toEqual({ action: "keep", refundMinor: 0, keptMinor: 50000 });
  });

  it("does nothing when nothing was paid online", () => {
    expect(decideRefund({ ...base, paidOnlineMinor: 0, event: "cancel", now: hoursBefore(48) })).toEqual({ action: "keep", refundMinor: 0, keptMinor: 0 });
  });

  it("treats a full payment (no separate deposit) as wholly kept after the window", () => {
    expect(decideRefund({ ...base, depositMinor: null, paidOnlineMinor: 80000, policy: { ...policy, afterWindowRule: "keep_deposit" }, event: "cancel", now: hoursBefore(1) })).toEqual({ action: "keep", refundMinor: 0, keptMinor: 80000 });
  });
});

describe("settings input", () => {
  it("bounds the policy and checks a Razorpay key id's shape", () => {
    expect(paymentPolicySchema.safeParse({ freeCancelHours: 24, afterWindowRule: "no_refund", noShowRule: "deposit" }).success).toBe(true);
    expect(paymentPolicySchema.safeParse({ freeCancelHours: -1, afterWindowRule: "no_refund", noShowRule: "deposit" }).success).toBe(false);
    expect(paymentPolicySchema.safeParse({ freeCancelHours: 24, afterWindowRule: "anything", noShowRule: "deposit" }).success).toBe(false);
    expect(paymentAccountInputSchema.safeParse({ provider: "razorpay", keyId: "rzp_test_abc123XYZ", keySecret: "secret-secret", webhookSecret: "hook-secret" }).success).toBe(true);
    expect(paymentAccountInputSchema.safeParse({ provider: "razorpay", keyId: "not-a-key", keySecret: "secret-secret", webhookSecret: "hook-secret" }).success).toBe(false);
    expect(paymentAccountInputSchema.safeParse({ provider: "razorpay", keyId: "rzp_test_abc123XYZ", keySecret: "x", webhookSecret: "hook-secret", extra: 1 }).success).toBe(false);
  });
});
