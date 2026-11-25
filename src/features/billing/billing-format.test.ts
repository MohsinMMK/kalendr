import { describe, expect, it } from "vitest";

import { freeState, makeState, paidState, fixedNow, inDays } from "./billing-fixtures";
import { daysUntil, planActionFor, shortDate, usageView } from "./billing-format";
import { planSummary, statusBadge } from "./plan-card";
import { trialDaysLeft } from "./billing-banners";
import { upgradeMessage } from "./upgrade-copy";

const labels = (state: ReturnType<typeof makeState>) => Object.fromEntries(state.plans.map((plan) => [plan.key, planActionFor(state, plan)]));

describe("what each plan button does", () => {
  it("lets a trial business keep Growth or pick another, and says Free comes after the trial", () => {
    const actions = labels(makeState());
    expect(actions.growth).toMatchObject({ kind: "checkout", label: "Keep this plan" });
    expect(actions.starter).toMatchObject({ kind: "checkout", label: "Upgrade" });
    expect(actions.free).toMatchObject({ kind: "none" });
  });

  it("starts checkout from Free", () => {
    const actions = labels(freeState());
    expect(actions.free).toMatchObject({ kind: "current" });
    expect(actions.starter).toMatchObject({ kind: "checkout", label: "Choose plan" });
  });

  it("upgrades now, downgrades at the period end and cancels to Free on a paid plan", () => {
    const actions = labels(paidState("growth"));
    expect(actions.growth).toMatchObject({ kind: "current" });
    expect(actions.scale).toMatchObject({ kind: "upgrade" });
    expect(actions.starter).toMatchObject({ kind: "downgrade", label: "Downgrade at period end" });
    expect(actions.free).toMatchObject({ kind: "cancel" });
  });

  it("shows a scheduled downgrade as scheduled", () => {
    expect(labels(paidState("growth", { pendingPlanKey: "starter" })).starter).toMatchObject({ kind: "scheduled" });
  });

  it("offers Keep my plan on a plan that ends, and Update payment when a payment failed", () => {
    expect(labels(paidState("starter", { cancelAtPeriodEnd: true })).starter).toMatchObject({ kind: "resume" });
    expect(labels(paidState("starter", { status: "past_due", graceEndsAt: inDays(5) })).starter).toMatchObject({ kind: "checkout", label: "Update payment" });
    expect(labels(makeState({ key: "starter", status: "cancelled", reason: "paid", currentPeriodEnd: inDays(4) })).starter).toMatchObject({ kind: "resume" });
  });

  it("treats a cancelled plan whose access ended like Free", () => {
    expect(labels(makeState({ key: "free", name: "Free", status: "cancelled", reason: "cancelled" })).growth).toMatchObject({ kind: "checkout" });
  });
});

describe("usage thresholds", () => {
  const view = (used: number, included: number | null) => usageView({ metric: "whatsapp", used, included });
  it("is quiet below 80%", () => expect(view(799, 1000)).toMatchObject({ level: "ok", status: "" }));
  it("says Almost used up from 80%", () => expect(view(800, 1000)).toMatchObject({ level: "near", status: "Almost used up", percent: 80 }));
  it("says All used at 100% and past it, and caps the bar", () => {
    expect(view(1000, 1000)).toMatchObject({ level: "over", status: "All used", percent: 100 });
    expect(view(1400, 1000)).toMatchObject({ level: "over", percent: 100 });
  });
  it("has no bar when nothing is included, and says so for a plan with none", () => {
    expect(view(7, null)).toMatchObject({ level: "none" });
    expect(view(0, 0).status).toBe("Not included in your plan");
  });
  it("labels unknown metrics in plain words", () => expect(usageView({ metric: "video_minutes", used: 1, included: 2 }).label).toBe("Video minutes"));
});

describe("plan card words", () => {
  it("counts the trial days", () => {
    expect(planSummary(makeState(), fixedNow)).toBe("Growth trial, 9 days left, no card needed");
    expect(planSummary(makeState({ trialEndsAt: inDays(1) }), fixedNow)).toContain("1 day left");
    expect(daysUntil(inDays(-3), fixedNow)).toBe(0);
  });
  it("says Free, the renewal date or the end date", () => {
    expect(planSummary(freeState(), fixedNow)).toBe("Free");
    expect(planSummary(paidState("starter"), fixedNow)).toContain("Renews on 1 Dec");
    expect(planSummary(paidState("starter", { cancelAtPeriodEnd: true }), fixedNow)).toBe("Ends on 1 Dec");
    expect(shortDate(inDays(400), fixedNow)).toMatch(/2027/);
  });
  it("badges the status in words", () => {
    expect(statusBadge(makeState(), fixedNow).label).toBe("Trial");
    expect(statusBadge(paidState("starter", { status: "past_due" }), fixedNow).label).toBe("Payment failed");
  });
});

describe("trial banner window", () => {
  it("shows with 3 days or fewer left", () => {
    expect(trialDaysLeft(makeState({ trialEndsAt: inDays(3) }), fixedNow)).toBe(3);
    expect(trialDaysLeft(makeState({ trialEndsAt: inDays(4) }), fixedNow)).toBeNull();
    expect(trialDaysLeft(paidState("starter"), fixedNow)).toBeNull();
  });
});

describe("upgrade sentence", () => {
  const words = { practitioner: "staff", practitioners: "staff" };
  const state = paidState("starter");
  it("names the limit on the current plan and on the one that unlocks it", () => {
    expect(upgradeMessage({ subject: "staffCalendars", requiredPlan: "growth", currentPlan: "starter", limit: 3 }, state.plans, words)).toBe("Your Starter plan includes 3 staff calendars. Growth includes 10.");
  });
  it("names a feature", () => {
    expect(upgradeMessage({ subject: "onlinePayments", requiredPlan: "starter", currentPlan: "free", limit: null }, state.plans, words)).toBe("Your Free plan does not include online payments. Starter does.");
  });
  it("stays honest when the server sent nothing readable", () => {
    expect(upgradeMessage({ subject: "plan", requiredPlan: null, currentPlan: "free", limit: null }, state.plans, words)).toBe("Your current plan does not include this.");
  });
});
