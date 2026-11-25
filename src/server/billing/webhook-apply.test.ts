import { describe, expect, it } from "vitest";

import type { PlanKey } from "../../lib/entitlements";
import type { SubscriptionRecord } from "./entitlement-loader";
import { applyBillingEvent, handledEventTypes } from "./webhook-apply";
import type { BillingEventExtract } from "./webhook-events";

const now = new Date("2026-11-19T10:00:00Z");
const day = 86_400_000;

const trial: SubscriptionRecord = {
  planKey: "growth", status: "trialing", provider: null, providerCustomerId: null, providerSubscriptionId: null, trialEndsAt: new Date(now.getTime() + 5 * day),
  currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, pendingPlanKey: null, pastDueSince: null,
  overageMode: "stop_marketing", billingGstin: null, usageAlertsSent: [], version: 1,
};
const active: SubscriptionRecord = { ...trial, planKey: "starter", status: "active", provider: "razorpay", providerSubscriptionId: "sub_1", currentPeriodStart: new Date(now.getTime() - 10 * day), currentPeriodEnd: new Date(now.getTime() + 20 * day), trialEndsAt: null };

function event(type: string, extra: Partial<BillingEventExtract> = {}): BillingEventExtract {
  return { provider: "razorpay", eventId: `evt-${type}`, type, tenantId: "t-1", providerSubscriptionId: "sub_1", providerCustomerId: null, providerPaymentId: null,
    providerPlanId: "plan_starter", planKey: null, status: null, amountMinor: null, currency: null, periodStart: new Date(now.getTime() - day).toISOString(),
    periodEnd: new Date(now.getTime() + 29 * day).toISOString(), cancelAtPeriodEnd: null, occurredAt: now.toISOString(), ...extra };
}

const planForProviderId = (_provider: "razorpay" | "stripe", id: string): PlanKey | null => ({ plan_starter: "starter", plan_growth: "growth", price_starter: "starter" } as Record<string, PlanKey>)[id] ?? null;
const apply = (e: BillingEventExtract, current: SubscriptionRecord) => applyBillingEvent({ event: e, current, now, planForProviderId });

describe("razorpay events", () => {
  it("subscription.activated on a trial makes the business Starter and active, and says thank you", () => {
    const result = apply(event("subscription.activated"), trial);
    expect(result.outcome).toBe("applied");
    expect(result.patch).toMatchObject({ planKey: "starter", status: "active", provider: "razorpay", providerSubscriptionId: "sub_1", pastDueSince: null });
    expect(result.emails).toEqual(["subscription_started"]);
  });

  it("subscription.charged issues an invoice for exactly the amount charged and clears dunning", () => {
    const pastDue = { ...active, status: "past_due" as const, pastDueSince: new Date(now.getTime() - 3 * day) };
    const result = apply(event("subscription.charged", { providerPaymentId: "pay_1", amountMinor: 49_900, currency: "INR" }), pastDue);
    expect(result.patch).toMatchObject({ status: "active", pastDueSince: null });
    expect(result.invoice).toMatchObject({ providerPaymentId: "pay_1", amountMinor: 49_900, currency: "INR", planKey: "starter" });
    expect(result.emails).toEqual([]);
  });

  it("a charge with no amount makes no invoice", () => {
    expect(apply(event("subscription.charged", { providerPaymentId: "pay_2", amountMinor: 0, currency: "INR" }), active).invoice).toBeNull();
  });

  it("subscription.pending starts the grace period and emails the owner", () => {
    const result = apply(event("subscription.pending"), active);
    expect(result.patch).toMatchObject({ status: "past_due", pastDueSince: now });
    expect(result.emails).toEqual(["payment_failed"]);
  });

  it("a second failure does NOT move the start of the grace period, so day 8 stays day 8", () => {
    const since = new Date(now.getTime() - 4 * day);
    const result = apply(event("subscription.halted"), { ...active, status: "past_due", pastDueSince: since });
    expect(result.patch.pastDueSince).toEqual(since);
    expect(result.emails).toEqual(["payment_failed"]);
  });

  it("payment.failed counts only when it belongs to a subscription", () => {
    expect(apply(event("payment.failed"), active).patch.status).toBe("past_due");
    expect(apply(event("payment.failed", { providerSubscriptionId: null }), active).outcome).toBe("ignored");
  });

  it.each([
    ["subscription.paused", "paused"], ["subscription.resumed", "active"], ["subscription.cancelled", "cancelled"], ["subscription.completed", "cancelled"],
  ] as const)("%s -> %s", (type, status) => {
    expect(apply(event(type), active).patch.status).toBe(status);
  });

  it("cancelled clears scheduled changes and keeps the paid period end for the sweep", () => {
    const result = apply(event("subscription.cancelled", { periodEnd: null }), { ...active, pendingPlanKey: "starter", cancelAtPeriodEnd: true });
    expect(result.patch).toMatchObject({ cancelAtPeriodEnd: false, pendingPlanKey: null });
    expect(result.patch.currentPeriodEnd).toBeUndefined();
  });

  it("prefers the provider's plan id over the notes, which still name the first plan after an upgrade", () => {
    const result = apply(event("subscription.charged", { providerPlanId: "plan_growth", planKey: "starter", providerPaymentId: "pay_3", amountMinor: 149_900, currency: "INR" }), active);
    expect(result.patch.planKey).toBe("growth");
  });
});

describe("pending downgrades", () => {
  const downgrading = { ...active, planKey: "growth" as const, pendingPlanKey: "starter" as const };
  it("keeps the paid plan while the period is still running", () => {
    const result = apply(event("customer.subscription.updated", { provider: "stripe", providerPlanId: "price_starter", status: "active" }), downgrading);
    expect(result.patch.planKey).toBeUndefined();
    expect(result.patch.pendingPlanKey).toBeUndefined();
  });
  it("applies it when the renewal arrives after the period has ended", () => {
    const ended = { ...downgrading, currentPeriodEnd: new Date(now.getTime() - 60_000) };
    const result = apply(event("subscription.charged", { providerPlanId: "plan_starter", providerPaymentId: "pay_4", amountMinor: 49_900, currency: "INR" }), ended);
    expect(result.patch).toMatchObject({ planKey: "starter", pendingPlanKey: null });
  });
});

describe("stripe events", () => {
  const stripe = (type: string, extra: Partial<BillingEventExtract> = {}) => event(type, { provider: "stripe", providerPlanId: "price_starter", providerCustomerId: "cus_1", ...extra });
  it("checkout.session.completed links the provider ids and activates", () => {
    const result = apply(stripe("checkout.session.completed", { planKey: "starter", providerPlanId: null }), { ...trial });
    expect(result.patch).toMatchObject({ status: "active", provider: "stripe", providerSubscriptionId: "sub_1", providerCustomerId: "cus_1", planKey: "starter" });
  });
  it("checkout.session.completed without a subscription is ignored", () => {
    expect(apply(stripe("checkout.session.completed", { providerSubscriptionId: null }), trial).outcome).toBe("ignored");
  });
  it.each([
    ["active", "active"], ["trialing", "active"], ["past_due", "past_due"], ["unpaid", "past_due"], ["canceled", "cancelled"], ["paused", "paused"],
  ] as const)("customer.subscription.updated with status %s -> %s", (status, expected) => {
    expect(apply(stripe("customer.subscription.updated", { status }), active).patch.status).toBe(expected);
  });
  it("incomplete subscriptions change nothing", () => {
    expect(apply(stripe("customer.subscription.created", { status: "incomplete" }), trial).outcome).toBe("ignored");
  });
  it("tracks cancel at period end", () => {
    expect(apply(stripe("customer.subscription.updated", { status: "active", cancelAtPeriodEnd: true }), active).patch.cancelAtPeriodEnd).toBe(true);
  });
  it("invoice.paid issues one invoice; invoice.payment_failed sends one email; subscription.updated past_due sends none", () => {
    expect(apply(stripe("invoice.paid", { providerPaymentId: "in_1", amountMinor: 900, currency: "USD" }), active).invoice).toMatchObject({ providerPaymentId: "in_1", amountMinor: 900, currency: "USD" });
    expect(apply(stripe("invoice.payment_failed"), active).emails).toEqual(["payment_failed"]);
    expect(apply(stripe("customer.subscription.updated", { status: "past_due" }), active).emails).toEqual([]);
  });
  it("customer.subscription.deleted ends it", () => {
    expect(apply(stripe("customer.subscription.deleted"), active).patch.status).toBe("cancelled");
  });
});

describe("unknown events", () => {
  it("are marked ignored and change nothing", () => {
    const result = apply(event("subscription.authenticated"), active);
    expect(result).toEqual({ outcome: "ignored", patch: {}, invoice: null, emails: [] });
  });
  it("covers every event type the spec names", () => {
    for (const type of ["subscription.activated", "subscription.charged", "subscription.halted", "subscription.pending", "subscription.paused", "subscription.resumed", "subscription.cancelled", "subscription.completed", "payment.failed",
      "checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "invoice.paid", "invoice.payment_failed"]) {
      expect(handledEventTypes).toContain(type);
    }
  });
});
