/**
 * Reads a business's subscription and plan limits through a `Runner`, so the web server (drizzle) and the worker
 * (postgres.js) share one query. No "server-only": the worker imports this.
 */
import { sql } from "drizzle-orm";

import { resolveEntitlements, trialDays, trialPlanKey, planKeySchema, subscriptionStatuses, type Entitlements, type PlanKey, type SubscriptionStatus } from "../../lib/entitlements";
import { asDate, asNumber, asString, type Row, type Runner } from "../workflows/runner";

export interface SubscriptionRecord {
  planKey: PlanKey;
  status: SubscriptionStatus;
  provider: "razorpay" | "stripe" | null;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  trialEndsAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  pendingPlanKey: PlanKey | null;
  pastDueSince: Date | null;
  overageMode: "stop_marketing" | "bill_overage";
  billingGstin: string | null;
  usageAlertsSent: string[];
  version: number;
}

export interface LoadedBilling {
  entitlements: Entitlements;
  subscription: SubscriptionRecord;
}

const optionalDate = (value: unknown): Date | null => (value === null || value === undefined ? null : asDate(value));
const optionalText = (value: unknown): string | null => (value === null || value === undefined ? null : asString(value));

function toRecord(row: Row): SubscriptionRecord {
  const plan = planKeySchema.safeParse(row.plan_key);
  const pending = planKeySchema.safeParse(row.pending_plan_key);
  const status = subscriptionStatuses.find((value) => value === row.status) ?? "free";
  return {
    planKey: plan.success ? plan.data : "free",
    status,
    provider: row.provider === "razorpay" || row.provider === "stripe" ? row.provider : null,
    providerCustomerId: optionalText(row.provider_customer_id),
    providerSubscriptionId: optionalText(row.provider_subscription_id),
    trialEndsAt: optionalDate(row.trial_ends_at),
    currentPeriodStart: optionalDate(row.current_period_start),
    currentPeriodEnd: optionalDate(row.current_period_end),
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
    pendingPlanKey: pending.success ? pending.data : null,
    pastDueSince: optionalDate(row.past_due_since),
    overageMode: row.overage_mode === "bill_overage" ? "bill_overage" : "stop_marketing",
    billingGstin: optionalText(row.billing_gstin),
    usageAlertsSent: Array.isArray(row.usage_alerts_sent) ? row.usage_alerts_sent.filter((item): item is string => typeof item === "string") : [],
    version: asNumber(row.version),
  };
}

function selectSubscription(run: Runner, tenantId: string, lock: boolean): Promise<Row[]> {
  return run(sql`
    select subscription.plan_key, subscription.status, subscription.provider, subscription.provider_customer_id,
      subscription.provider_subscription_id, subscription.trial_ends_at, subscription.current_period_start,
      subscription.current_period_end, subscription.cancel_at_period_end, subscription.pending_plan_key,
      subscription.past_due_since, subscription.overage_mode, subscription.billing_gstin, subscription.usage_alerts_sent,
      subscription.version, (select jsonb_object_agg(plan.key, plan.limits) from plans as plan) as plan_limits
    from tenant_subscriptions as subscription
    where subscription.tenant_id = ${tenantId}
    ${lock ? sql`for update of subscription` : sql``}
  `);
}

export interface LoadOptions {
  now?: Date;
  /** Lock the subscription row until the transaction ends, so two concurrent changes cannot both pass a limit check. */
  lock?: boolean;
}

/**
 * One statement reads the subscription and every plan's limits (the effective plan can differ from the stored one).
 * A business with no row yet, such as a seeded dev business made after the migration's backfill, gets a Growth trial
 * started here; ON CONFLICT DO NOTHING keeps two racing requests from making two.
 */
export async function loadBilling(run: Runner, tenantId: string, options: LoadOptions = {}): Promise<LoadedBilling> {
  const now = options.now ?? new Date();
  let rows = await selectSubscription(run, tenantId, options.lock ?? false);
  if (rows.length === 0) {
    await run(sql`
      insert into tenant_subscriptions (tenant_id, plan_key, status, trial_ends_at)
      values (${tenantId}, ${trialPlanKey}, 'trialing', ${new Date(now.getTime() + trialDays * 86_400_000).toISOString()}::timestamptz)
      on conflict (tenant_id) do nothing
    `);
    rows = await selectSubscription(run, tenantId, options.lock ?? false);
  }
  const row = rows[0];
  if (!row) throw new Error("Subscription row missing after insert");
  const subscription = toRecord(row);
  const limits = row.plan_limits && typeof row.plan_limits === "object" ? row.plan_limits : {};
  return {
    subscription,
    entitlements: resolveEntitlements(subscription, limits as Partial<Record<PlanKey, unknown>>, now),
  };
}
