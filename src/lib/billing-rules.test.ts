import { describe, expect, it } from "vitest";

import { chooseBillingProvider, decideMessageGate, invoiceAmounts, isProtectedMessage, isUpgrade, planLimitMessage, splitInclusiveGst, usageAlertMarker, usageAlertsDue, usagePeriod, type MessageGateInput } from "./billing-rules";
import { planDefinitions } from "./entitlements";

describe("chooseBillingProvider", () => {
  it.each([
    ["INR", "en-IN", "Asia/Kolkata", "razorpay"],
    ["INR", "hi-IN", "Asia/Calcutta", "razorpay"],
    // Sign-up never asks for a country, so every business starts as INR; the locale and zone decide.
    ["INR", "en-US", "America/New_York", "stripe"],
    ["INR", "en-GB", "Europe/London", "stripe"],
    ["USD", "en-IN", "Asia/Kolkata", "stripe"],
    ["EUR", "de-DE", "Europe/Berlin", "stripe"],
    ["INR", "en-US", "Asia/Kolkata", "razorpay"],
  ] as const)("%s %s %s -> %s", (currency, locale, timezone, expected) => {
    expect(chooseBillingProvider({ currency, locale, timezone })).toBe(expected);
  });
});

describe("GST on invoices", () => {
  it.each([49_900, 149_900, 399_900, 118, 1, 100_000])("splits %i paise so amount plus GST is exactly the total", (total) => {
    const { amountMinor, gstMinor } = splitInclusiveGst(total);
    expect(amountMinor + gstMinor).toBe(total);
    expect(Math.abs(gstMinor - (total * 18) / 118)).toBeLessThanOrEqual(0.5);
  });

  it("works the numbers for the Starter price", () => {
    expect(invoiceAmounts("INR", 49_900)).toEqual({ amountMinor: 42_288, gstRateBps: 1800, gstMinor: 7_612, totalMinor: 49_900 });
  });

  it("adds no GST outside India", () => {
    expect(invoiceAmounts("USD", 900)).toEqual({ amountMinor: 900, gstRateBps: 0, gstMinor: 0, totalMinor: 900 });
    expect(invoiceAmounts("usd", 2_900).gstMinor).toBe(0);
  });
});

describe("usage alerts", () => {
  const now = new Date("2026-11-19T10:00:00Z");
  it("uses the UTC month as the period", () => {
    expect(usagePeriod(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-01");
    expect(usagePeriod(new Date("2027-01-01T00:00:00Z"))).toBe("2027-01-01");
  });
  it("alerts at 80% and 100% and not before", () => {
    expect(usageAlertsDue({ channel: "whatsapp", used: 159, included: 200, sent: [], now })).toEqual([]);
    expect(usageAlertsDue({ channel: "whatsapp", used: 160, included: 200, sent: [], now })).toEqual([80]);
    expect(usageAlertsDue({ channel: "whatsapp", used: 200, included: 200, sent: [], now })).toEqual([80, 100]);
  });
  it("sends each threshold once a month", () => {
    const sent = [usageAlertMarker("whatsapp", 80, now)];
    expect(usageAlertsDue({ channel: "whatsapp", used: 170, included: 200, sent, now })).toEqual([]);
    expect(usageAlertsDue({ channel: "whatsapp", used: 200, included: 200, sent, now })).toEqual([100]);
    // A new month needs no reset: the marker names the month.
    expect(usageAlertsDue({ channel: "whatsapp", used: 170, included: 200, sent, now: new Date("2026-12-02T00:00:00Z") })).toEqual([80]);
  });
  it("has nothing to announce when the plan includes none", () => {
    expect(usageAlertsDue({ channel: "sms", used: 5, included: 0, sent: [], now })).toEqual([]);
  });
});

const base: MessageGateInput = {
  channel: "whatsapp", templateKey: "appointment.reminder", costCategory: "utility", limits: planDefinitions.free.limits,
  used: 0, overageMode: "stop_marketing", hasUsableEmail: true,
};

describe("message gate: confirmations and reminders are never silently stopped", () => {
  it.each(["appointment.created", "appointment.confirm", "appointment.status.booked", "appointment.reminder", "appointment.reschedule", "appointment.cancel"])("%s is protected", (key) => {
    expect(isProtectedMessage(key)).toBe(true);
  });
  it("treats review requests and unknown messages as stoppable", () => {
    expect(isProtectedMessage("appointment.review_request")).toBe(false);
    expect(isProtectedMessage("workflow:abc")).toBe(false);
  });

  it("falls back to email when the plan has no WhatsApp and the customer has an email", () => {
    expect(decideMessageGate(base)).toEqual({ action: "fallback_email" });
  });
  it("still sends, with an alert, when there is no email to fall back to", () => {
    expect(decideMessageGate({ ...base, hasUsableEmail: false })).toEqual({ action: "send_anyway", alert: "no_email_fallback" });
  });
  it("never blocks a protected message, on any plan, at any usage", () => {
    for (const plan of ["free", "starter", "growth", "scale"] as const) {
      for (const used of [0, 150, 99_999]) {
        for (const overageMode of ["stop_marketing", "bill_overage"] as const) {
          for (const hasUsableEmail of [true, false]) {
            const decision = decideMessageGate({ ...base, limits: planDefinitions[plan].limits, used, overageMode, hasUsableEmail, costCategory: "marketing" });
            expect(decision.action).not.toBe("block");
          }
        }
      }
    }
  });
  it("stops a review request on a plan with no WhatsApp, with a clear code", () => {
    expect(decideMessageGate({ ...base, templateKey: "appointment.review_request", costCategory: "marketing" })).toEqual({ action: "block", code: "plan_channel_locked" });
  });
  it("lets email through on every plan", () => {
    expect(decideMessageGate({ ...base, channel: "email" })).toEqual({ action: "send" });
  });
});

describe("message gate: marketing past the allowance", () => {
  const starter = { ...base, limits: planDefinitions.starter.limits, templateKey: "appointment.review_request", costCategory: "marketing" };
  it("stops marketing past the included amount when the owner chose to stop it", () => {
    expect(decideMessageGate({ ...starter, used: 200 })).toEqual({ action: "block", code: "plan_overage_stopped" });
  });
  it("sends it (and it is counted as overage) when the owner chose to be billed", () => {
    expect(decideMessageGate({ ...starter, used: 500, overageMode: "bill_overage" })).toEqual({ action: "send" });
  });
  it("sends marketing while there is allowance left", () => {
    expect(decideMessageGate({ ...starter, used: 199 })).toEqual({ action: "send" });
  });
  it("keeps sending utility messages past the allowance", () => {
    expect(decideMessageGate({ ...starter, templateKey: "appointment.reminder", costCategory: "utility", used: 900 })).toEqual({ action: "send" });
  });
});

describe("upgrade copy", () => {
  it("names the plan that unlocks the thing", () => {
    expect(planLimitMessage("WhatsApp messages", "starter", "free")).toContain("Starter");
    expect(planLimitMessage("More staff calendars", "growth", "starter")).toBe("More staff calendars isn't included in the Starter plan. Upgrade to Growth to use it.");
    expect(planLimitMessage("More staff calendars", null, "scale")).toContain("Contact us");
  });
  it("tells an upgrade from a downgrade", () => {
    expect(isUpgrade("starter", "growth")).toBe(true);
    expect(isUpgrade("growth", "starter")).toBe(false);
    expect(isUpgrade("growth", "growth")).toBe(false);
  });
});
