import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { extractRazorpayEvent, extractStripeEvent, verifyRazorpaySignature, verifyStripeSignature } from "./webhook-events";

const secret = "whsec_test_secret_not_real";
const now = new Date("2026-11-19T10:00:00Z");

describe("Razorpay signature", () => {
  const body = JSON.stringify({ event: "subscription.activated" });
  const good = createHmac("sha256", secret).update(body).digest("hex");
  it("accepts the HMAC-SHA256 of the raw body", () => expect(verifyRazorpaySignature(body, good, secret)).toBe(true));
  it("rejects a different body, a different secret, a missing or malformed header", () => {
    expect(verifyRazorpaySignature(`${body} `, good, secret)).toBe(false);
    expect(verifyRazorpaySignature(body, good, "other")).toBe(false);
    expect(verifyRazorpaySignature(body, null, secret)).toBe(false);
    expect(verifyRazorpaySignature(body, "zz", secret)).toBe(false);
    expect(verifyRazorpaySignature(body, good, "")).toBe(false);
  });
});

describe("Stripe signature", () => {
  const body = JSON.stringify({ id: "evt_1" });
  const sign = (at: Date, text = body, key = secret) => {
    const t = Math.floor(at.getTime() / 1000);
    return `t=${t},v1=${createHmac("sha256", key).update(`${t}.${text}`).digest("hex")}`;
  };
  it("accepts a fresh, correct signature", () => expect(verifyStripeSignature(body, sign(now), secret, now)).toBe(true));
  it("accepts any one of several v1 values while a secret rotates", () => {
    expect(verifyStripeSignature(body, `${sign(now)},v1=${"0".repeat(64)}`, secret, now)).toBe(true);
  });
  it("rejects a bad signature", () => {
    expect(verifyStripeSignature(body, sign(now, body, "other"), secret, now)).toBe(false);
    expect(verifyStripeSignature(`${body}x`, sign(now), secret, now)).toBe(false);
    expect(verifyStripeSignature(body, null, secret, now)).toBe(false);
    expect(verifyStripeSignature(body, "t=abc,v1=00", secret, now)).toBe(false);
  });
  it("rejects an old timestamp even when the signature is right", () => {
    expect(verifyStripeSignature(body, sign(new Date(now.getTime() - 6 * 60_000)), secret, now)).toBe(false);
    expect(verifyStripeSignature(body, sign(new Date(now.getTime() - 4 * 60_000)), secret, now)).toBe(true);
    expect(verifyStripeSignature(body, sign(new Date(now.getTime() + 6 * 60_000)), secret, now)).toBe(false);
  });
});

describe("what is stored from an event", () => {
  it("keeps ids, amounts and plan data from a Razorpay charge, and no contact or payment-instrument details", () => {
    const body = JSON.stringify({
      event: "subscription.charged", created_at: 1_790_000_000,
      payload: {
        subscription: { entity: { id: "sub_1", plan_id: "plan_9", customer_id: "cust_1", status: "active", notes: { tenantId: "t-1", planKey: "starter" }, current_start: 1_790_000_000, current_end: 1_792_592_000, email: "owner@example.com" } },
        payment: { entity: { id: "pay_1", amount: 49_900, currency: "INR", status: "captured", vpa: "owner@okbank", email: "owner@example.com", contact: "+919999999999", card: { last4: "4242" } } },
      },
    });
    const extract = extractRazorpayEvent(body, "evt_header_1");
    expect(extract).toMatchObject({ provider: "razorpay", eventId: "evt_header_1", type: "subscription.charged", tenantId: "t-1", planKey: "starter", providerSubscriptionId: "sub_1", providerPaymentId: "pay_1", amountMinor: 49_900, currency: "INR", providerPlanId: "plan_9" });
    const stored = JSON.stringify(extract);
    for (const secretThing of ["owner@example.com", "okbank", "+919999999999", "4242", "contact", "vpa"]) expect(stored).not.toContain(secretThing);
  });
  it("handles Razorpay's empty-array notes and unreadable bodies", () => {
    const body = JSON.stringify({ event: "subscription.pending", payload: { subscription: { entity: { id: "sub_2", notes: [] } } } });
    expect(extractRazorpayEvent(body, null)?.tenantId).toBeNull();
    expect(extractRazorpayEvent(body, null)?.eventId).toMatch(/^body:/);
    expect(extractRazorpayEvent("not json", null)).toBeNull();
    expect(extractRazorpayEvent(JSON.stringify({ nope: 1 }), null)).toBeNull();
  });
  it("keeps the same fields from Stripe invoices and subscriptions", () => {
    const invoice = extractStripeEvent(JSON.stringify({
      id: "evt_s1", type: "invoice.paid", created: 1_790_000_000,
      data: { object: { id: "in_1", customer: "cus_1", amount_paid: 900, currency: "usd", customer_email: "owner@example.com", customer_name: "Owner",
        parent: { subscription_details: { subscription: "sub_s1", metadata: { tenantId: "t-2", planKey: "starter" } } },
        lines: { data: [{ period: { start: 1_790_000_000, end: 1_792_592_000 }, pricing: { price_details: { price: "price_1" } } }] } } },
    }));
    expect(invoice).toMatchObject({ provider: "stripe", type: "invoice.paid", tenantId: "t-2", providerSubscriptionId: "sub_s1", providerPaymentId: "in_1", amountMinor: 900, currency: "USD", providerPlanId: "price_1" });
    expect(JSON.stringify(invoice)).not.toContain("owner@example.com");
    const subscription = extractStripeEvent(JSON.stringify({
      id: "evt_s2", type: "customer.subscription.updated",
      data: { object: { id: "sub_s1", customer: "cus_1", status: "past_due", cancel_at_period_end: true, metadata: { tenantId: "t-2" }, items: { data: [{ price: { id: "price_2" }, current_period_start: 1_790_000_000, current_period_end: 1_792_592_000 }] } } },
    }));
    expect(subscription).toMatchObject({ providerSubscriptionId: "sub_s1", status: "past_due", cancelAtPeriodEnd: true, providerPlanId: "price_2" });
    expect(subscription?.periodEnd).toBe(new Date(1_792_592_000_000).toISOString());
  });
});
