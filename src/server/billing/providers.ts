/**
 * Which provider adapter to use and which provider plan id belongs to a plan. No "server-only": the worker imports
 * this to apply plan changes at the period end.
 */
import { sql } from "drizzle-orm";

import type { BillingProvider } from "../../lib/billing-contracts";
import type { PlanKey } from "../../lib/entitlements";
import { env } from "../env";
import type { Runner } from "../workflows/runner";
import { overriddenProvider, type SubscriptionProvider } from "./provider";
import { createRazorpayProvider } from "./razorpay";
import { createStripeProvider } from "./stripe";

export function providerKeysPresent(name: BillingProvider): boolean {
  const settings = env();
  return name === "razorpay" ? Boolean(settings.RAZORPAY_KEY_ID && settings.RAZORPAY_KEY_SECRET) : Boolean(settings.STRIPE_SECRET_KEY);
}

/** The adapter for a provider. Without keys it still returns one; its calls throw `ProviderNotConfiguredError`. */
export function getSubscriptionProvider(name: BillingProvider): SubscriptionProvider {
  const injected = overriddenProvider(name);
  if (injected) return injected;
  const settings = env();
  return name === "razorpay"
    ? createRazorpayProvider(settings.RAZORPAY_KEY_ID && settings.RAZORPAY_KEY_SECRET ? { keyId: settings.RAZORPAY_KEY_ID, keySecret: settings.RAZORPAY_KEY_SECRET } : null)
    : createStripeProvider(settings.STRIPE_SECRET_KEY ?? null);
}

/** True when checkout can run for this provider: keys set and the paid plans have provider ids. Tests that inject a fake count as configured. */
export async function checkoutAvailable(run: Runner, name: BillingProvider): Promise<boolean> {
  if (overriddenProvider(name)) return true;
  if (!providerKeysPresent(name)) return false;
  const map = await providerPlanIds(run, name);
  return (["starter", "growth", "scale"] as const).every((key) => Boolean(map[key]));
}

export type ProviderPlanIds = Partial<Record<PlanKey, string>>;

/** Provider plan or price ids by plan key. Environment variables win over the plans table so a deploy can override. */
export async function providerPlanIds(run: Runner, name: BillingProvider): Promise<ProviderPlanIds> {
  const settings = env();
  const fromEnv: ProviderPlanIds = name === "razorpay"
    ? { starter: settings.RAZORPAY_PLAN_ID_STARTER, growth: settings.RAZORPAY_PLAN_ID_GROWTH, scale: settings.RAZORPAY_PLAN_ID_SCALE }
    : { starter: settings.STRIPE_PRICE_ID_STARTER, growth: settings.STRIPE_PRICE_ID_GROWTH, scale: settings.STRIPE_PRICE_ID_SCALE };
  const rows = await run(sql`select key, razorpay_plan_id, stripe_price_id from plans`);
  const result: ProviderPlanIds = {};
  for (const row of rows) {
    const key = row.key as PlanKey;
    const stored = name === "razorpay" ? row.razorpay_plan_id : row.stripe_price_id;
    const value = fromEnv[key] ?? (typeof stored === "string" && stored ? stored : undefined);
    if (value) result[key] = value;
  }
  return result;
}

/** The reverse lookup a webhook needs: which plan does this provider id belong to. */
export function planKeyForProviderId(ids: ProviderPlanIds, providerPlanId: string): PlanKey | null {
  const found = (Object.entries(ids) as [PlanKey, string][]).find(([, value]) => value === providerPlanId);
  return found ? found[0] : null;
}
