/**
 * The worker's side of a subscription webhook (feature 14): read the stored event, apply it to the business's
 * subscription, issue the invoice for a successful charge and queue the owner's email, all in the one transaction
 * the outbox handler gives it. No "server-only": the worker imports this.
 */
import type postgres from "postgres";

import { env } from "../env";
import { postgresRunner } from "../workflows/runner";
import { loadBilling } from "./entitlement-loader";
import { issueInvoice } from "./invoices";
import { planKeyForProviderId, providerPlanIds } from "./providers";
import { applyBillingEvent, type BillingEmail, type SubscriptionPatch } from "./webhook-apply";
import { billingEventExtractSchema } from "./webhook-events";

type TenantDb = postgres.TransactionSql;

export type ProcessOutcome = "applied" | "ignored" | "already_processed" | "missing" | "invalid";

const columns: Record<keyof SubscriptionPatch, string> = {
  planKey: "plan_key", status: "status", provider: "provider", providerCustomerId: "provider_customer_id",
  providerSubscriptionId: "provider_subscription_id", currentPeriodStart: "current_period_start", currentPeriodEnd: "current_period_end",
  cancelAtPeriodEnd: "cancel_at_period_end", pendingPlanKey: "pending_plan_key", pastDueSince: "past_due_since",
};

/** Writes only the fields the patch names. Every change bumps `version`, so a settings edit made from a stale screen is refused. */
export async function writeSubscriptionPatch(tenantDb: TenantDb, tenantId: string, patch: SubscriptionPatch): Promise<void> {
  const row: Record<string, string | number | boolean | Date | null> = {};
  for (const [key, column] of Object.entries(columns)) {
    const value = patch[key as keyof SubscriptionPatch];
    if (value !== undefined) row[column] = value;
  }
  const names = Object.keys(row);
  if (names.length === 0) return;
  await tenantDb`update tenant_subscriptions set ${tenantDb(row, ...names)}, version = version + 1, updated_at = now() where tenant_id = ${tenantId}`;
}

export async function queueBillingEmail(tenantDb: TenantDb, tenantId: string, kind: BillingEmail | "trial_ending", dedupe: string, data: Record<string, unknown> = {}): Promise<void> {
  await tenantDb`
    insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
    values (${tenantId}, 'billing', ${tenantId}, 'billing.email', ${tenantDb.json({ kind, ...data } as postgres.JSONValue)}, ${`billing.email:${kind}:${dedupe}`.slice(0, 200)})
    on conflict (tenant_id, dedupe_key) do nothing
  `;
}

async function planLookup(tenantDb: TenantDb): Promise<(provider: "razorpay" | "stripe", id: string) => ReturnType<typeof planKeyForProviderId>> {
  const run = postgresRunner(tenantDb);
  const maps = { razorpay: await providerPlanIds(run, "razorpay"), stripe: await providerPlanIds(run, "stripe") };
  return (provider, id) => planKeyForProviderId(maps[provider], id);
}

export async function processBillingEvent(tenantDb: TenantDb, tenantId: string, billingEventId: string, now: Date): Promise<ProcessOutcome> {
  const [stored] = await tenantDb<{ payload: unknown; processed_at: Date | null }[]>`
    select payload, processed_at from billing_events where tenant_id = ${tenantId} and id = ${billingEventId} for update
  `;
  if (!stored) return "missing";
  if (stored.processed_at) return "already_processed";
  const mark = async (outcome: string): Promise<void> => {
    await tenantDb`update billing_events set processed_at = now(), outcome = ${outcome} where tenant_id = ${tenantId} and id = ${billingEventId}`;
  };
  const parsed = billingEventExtractSchema.safeParse(stored.payload);
  if (!parsed.success) { await mark("invalid"); return "invalid"; }

  // Locks the subscription row for the rest of the transaction, so events for one business apply one at a time.
  const { subscription } = await loadBilling(postgresRunner(tenantDb), tenantId, { lock: true, now });
  const result = applyBillingEvent({ event: parsed.data, current: subscription, now, planForProviderId: await planLookup(tenantDb) });
  if (result.outcome === "ignored") { await mark("ignored"); return "ignored"; }

  await writeSubscriptionPatch(tenantDb, tenantId, result.patch);
  if (result.invoice) {
    await issueInvoice(tenantDb, tenantId, parsed.data.provider, result.invoice, { kalendrGstin: env().KALENDR_GSTIN ?? null, buyerGstin: subscription.billingGstin });
  }
  for (const kind of result.emails) {
    await queueBillingEmail(tenantDb, tenantId, kind, billingEventId, kind === "subscription_started" ? { planKey: result.patch.planKey ?? subscription.planKey } : {});
  }
  await mark("applied");
  return "applied";
}
