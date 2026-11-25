import { describe, expect, it } from "vitest";

import {
  couponRefusal, expiryReminderText, GENERIC_COUPON_REFUSAL, graceEndsAt, isValidCode, membershipBenefitsOn, normaliseCode, priceBooking, reminderDue, type CouponFacts,
} from "./offers";

const coupon = (overrides: Partial<CouponFacts> = {}): CouponFacts => ({
  isActive: true, validFrom: null, validTo: null, serviceIds: [], firstVisitOnly: false, maxUses: null, perCustomerLimit: null, ...overrides,
});
const use = { now: new Date("2026-11-20T10:00:00Z"), serviceId: "svc", hasPriorVisit: false, customerUses: 0, totalUses: 0 };

describe("pricing order", () => {
  it("takes the member price first, then the coupon on what is left", () => {
    const result = priceBooking({ listMinor: 100_000, memberPercent: 20, coupon: { kind: "percent", value: 10, stackable: true } });
    expect(result.discounts).toEqual([{ kind: "member_price", amountMinor: 20_000 }, { kind: "coupon", amountMinor: 8_000 }]);
    expect(result.netMinor).toBe(72_000);
  });
  it("is not the same as taking the coupon first", () => {
    const memberFirst = priceBooking({ listMinor: 100_000, memberPercent: 20, coupon: { kind: "fixed", value: 30_000, stackable: true } }).netMinor;
    expect(memberFirst).toBe(50_000);
    expect(priceBooking({ listMinor: 100_000, coupon: { kind: "fixed", value: 30_000, stackable: true } }).netMinor).toBe(70_000);
  });
  it("allows one discount by default: a coupon that is not stackable is refused on top of a member price", () => {
    const result = priceBooking({ listMinor: 100_000, memberPercent: 20, coupon: { kind: "percent", value: 10, stackable: false } });
    expect(result).toMatchObject({ netMinor: 80_000, couponRefused: "not_stackable" });
    expect(result.discounts).toHaveLength(1);
  });
  it("never goes below zero and rounds halves up to the paisa", () => {
    expect(priceBooking({ listMinor: 5_000, coupon: { kind: "fixed", value: 9_000, stackable: false } })).toMatchObject({ netMinor: 0, discounts: [{ kind: "coupon", amountMinor: 5_000 }] });
    expect(priceBooking({ listMinor: 1_001, coupon: { kind: "percent", value: 50, stackable: false } }).discounts[0]!.amountMinor).toBe(501);
    expect(priceBooking({ listMinor: 1_000 }).netMinor).toBe(1_000);
  });
});

describe("coupon rules", () => {
  it("checks dates, service, first visit and both limits", () => {
    expect(couponRefusal(coupon(), use)).toBeNull();
    expect(couponRefusal(coupon({ isActive: false }), use)).toBe("inactive");
    expect(couponRefusal(coupon({ validFrom: new Date("2026-12-01T00:00:00Z") }), use)).toBe("not_started");
    expect(couponRefusal(coupon({ validTo: new Date("2026-11-20T10:00:00Z") }), use)).toBe("expired");
    expect(couponRefusal(coupon({ serviceIds: ["other"] }), use)).toBe("wrong_service");
    expect(couponRefusal(coupon({ firstVisitOnly: true }), { ...use, hasPriorVisit: true })).toBe("not_first_visit");
    expect(couponRefusal(coupon({ perCustomerLimit: 1 }), { ...use, customerUses: 1 })).toBe("customer_limit");
    expect(couponRefusal(coupon({ maxUses: 100 }), { ...use, totalUses: 99 })).toBeNull();
    expect(couponRefusal(coupon({ maxUses: 100 }), { ...use, totalUses: 100 })).toBe("used_up");
  });
  it("normalises what the customer types and has one answer for every failure", () => {
    expect(normaliseCode(" welcome 10 ")).toBe("WELCOME10");
    expect(isValidCode("WELCOME10")).toBe(true);
    expect(isValidCode("ab")).toBe(false);
    expect(GENERIC_COUPON_REFUSAL).not.toMatch(/expired|used|wrong/i);
  });
});

describe("memberships", () => {
  const now = new Date("2026-11-20T10:00:00Z");
  it("keeps benefits for 7 days after a failed renewal, then pauses them", () => {
    expect(membershipBenefitsOn("active", null, now)).toBe(true);
    const failed = new Date("2026-11-15T10:00:00Z");
    expect(membershipBenefitsOn("past_due", failed, now)).toBe(true);
    expect(membershipBenefitsOn("past_due", new Date("2026-11-13T09:59:00Z"), now)).toBe(false);
    expect(membershipBenefitsOn("paused", null, now)).toBe(false);
    expect(membershipBenefitsOn("cancelled", null, now)).toBe(false);
    expect(graceEndsAt(failed).toISOString()).toBe("2026-11-22T10:00:00.000Z");
  });
});

describe("expiry reminders", () => {
  const expiresAt = new Date("2027-03-30T18:29:00Z");
  const base = { expiresAt, remaining: 3, sent14: false, sent3: false };
  it("sends the 14-day and 3-day reminder once each, only while credits are left", () => {
    expect(reminderDue({ ...base, now: new Date("2027-03-10T00:00:00Z") })).toBeNull();
    expect(reminderDue({ ...base, now: new Date("2027-03-17T00:00:00Z") })).toBe(14);
    expect(reminderDue({ ...base, sent14: true, now: new Date("2027-03-20T00:00:00Z") })).toBeNull();
    expect(reminderDue({ ...base, sent14: true, now: new Date("2027-03-28T00:00:00Z") })).toBe(3);
    expect(reminderDue({ ...base, sent14: true, sent3: true, now: new Date("2027-03-29T00:00:00Z") })).toBeNull();
    expect(reminderDue({ ...base, remaining: 0, now: new Date("2027-03-28T00:00:00Z") })).toBeNull();
    expect(reminderDue({ ...base, now: new Date("2027-04-01T00:00:00Z") })).toBeNull();
  });
  it("writes the message in plain words", () => {
    expect(expiryReminderText({ name: "10 massages", remaining: 3, validUntil: expiresAt, timeZone: "Asia/Kolkata", businessName: "Glow" })).toBe("Glow: You have 3 sessions left on 10 massages, valid until 30 March.");
    expect(expiryReminderText({ name: "Pack", remaining: 1, validUntil: expiresAt, timeZone: "Asia/Kolkata", businessName: "Glow" })).toContain("1 session left");
  });
});
