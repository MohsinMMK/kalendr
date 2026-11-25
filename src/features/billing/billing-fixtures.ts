import type { BillingState } from "@/lib/billing-contracts";

import { previewBillingState } from "./billing-api";

export const fixedNow = new Date("2026-11-19T10:00:00.000Z");
const day = 86_400_000;
export const inDays = (days: number) => new Date(fixedNow.getTime() + days * day).toISOString();

type PlanOverrides = Partial<BillingState["plan"]>;

/** A BillingState for tests: a Growth trial with 9 days left, unless told otherwise. */
export function makeState(plan: PlanOverrides = {}, rest: Partial<Omit<BillingState, "plan">> = {}): BillingState {
  const base = previewBillingState("INR");
  return { ...base, plan: { ...base.plan, trialEndsAt: inDays(9), ...plan }, checkoutAvailable: true, ...rest };
}

export const paidState = (key: BillingState["plan"]["key"] = "starter", plan: PlanOverrides = {}, rest: Partial<Omit<BillingState, "plan">> = {}) =>
  makeState({ key, name: key.charAt(0).toUpperCase() + key.slice(1), status: "active", reason: "paid", trialEndsAt: null, currentPeriodEnd: inDays(12), ...plan }, rest);

export const freeState = (rest: Partial<Omit<BillingState, "plan">> = {}) =>
  makeState({ key: "free", name: "Free", status: "free", reason: "free", trialEndsAt: null }, rest);
