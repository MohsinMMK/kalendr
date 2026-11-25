import "server-only";

import { eq } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import { withTenant } from "@/db/client";
import { outboxEvents, tenants, tenantSubscriptions } from "@/db/schema";
import { billingSettingsInputSchema, type CheckoutResult } from "@/lib/billing-contracts";
import { chooseBillingProvider, isUpgrade } from "@/lib/billing-rules";
import type { PlanKey } from "@/lib/entitlements";
import type { z } from "zod";

import { ApiError } from "../api-error";
import { appOrigin } from "../env";
import { getIdempotencyKey } from "../http";
import { claimKey, finishKey } from "../idempotent";
import { requireRecentStepUp, requirePermission, type StaffContext } from "../staff-context";
import { currentTraceParent } from "../tracing";
import { drizzleRunner } from "../workflows/runner";
import { loadBilling, type SubscriptionRecord } from "./entitlement-loader";
import { ProviderNotConfiguredError } from "./provider";
import { checkoutAvailable, getSubscriptionProvider, providerPlanIds } from "./providers";
import { recordBillingAudit } from "./subscriptions";
import { BILLING_PROVIDER_EVENT } from "./webhook-events";

/**
 * Choosing, changing, cancelling and resuming a plan (feature 14). Only creating a checkout (and an upgrade, which
 * charges the pro-rated difference while the owner waits) talks to a provider inside the request. Everything else is
 * recorded here and queued for the worker, so a slow provider never holds up a screen.
 */

type Transaction = Pick<KalendrTransaction, "insert" | "update" | "select" | "execute">;
type Paid = Exclude<PlanKey, "free">;

const isSubscribed = (subscription: SubscriptionRecord): boolean =>
  Boolean(subscription.providerSubscriptionId) && (subscription.status === "active" || subscription.status === "past_due" || subscription.status === "paused");

function refuseInPreview(context: StaffContext): void {
  if (context.preview) throw new ApiError(400, "preview_only", "Plans can't be changed in preview mode.");
}

async function queueProviderChange(transaction: Transaction, tenantId: string, action: "downgrade" | "cancel" | "resume", planKey?: PlanKey): Promise<void> {
  await transaction.insert(outboxEvents).values({
    tenantId, aggregateType: "billing", aggregateId: tenantId, eventType: BILLING_PROVIDER_EVENT,
    payload: { action, ...(planKey ? { planKey } : {}) },
    // Time-stamped: each press is its own job, and a double click inside the same second is one.
    dedupeKey: `billing.provider_change:${action}:${planKey ?? "-"}:${Math.floor(Date.now() / 1000)}`,
    traceParent: currentTraceParent(),
  }).onConflictDoNothing();
}

function providerFailure(error: unknown): ApiError {
  if (error instanceof ProviderNotConfiguredError) return new ApiError(503, "billing_unavailable", "Paid plans can't be started here yet. Please try again later.");
  return new ApiError(502, "provider_error", "We couldn't reach the payment provider. Nothing was charged or changed. Please try again.");
}

async function startCheckoutIn(transaction: Transaction, context: StaffContext, planKey: Paid, now: Date): Promise<CheckoutResult> {
  const run = drizzleRunner(transaction);
  const { subscription } = await loadBilling(run, context.tenantId, { lock: true, now });
  if (isSubscribed(subscription)) throw new ApiError(409, "already_subscribed", "You already have a paid plan. Use Change plan instead.");
  const [tenant] = await transaction.select({ currency: tenants.currency, locale: tenants.locale, timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, context.tenantId)).limit(1);
  const providerName = chooseBillingProvider({ currency: tenant?.currency ?? "INR", locale: tenant?.locale ?? "en-IN", timezone: tenant?.timezone ?? "Asia/Kolkata" });
  if (!(await checkoutAvailable(run, providerName))) throw providerFailure(new ProviderNotConfiguredError(providerName));
  const providerPlanId = (await providerPlanIds(run, providerName))[planKey];
  if (!providerPlanId) throw providerFailure(new ProviderNotConfiguredError(providerName));
  let outcome;
  try {
    // The one outside call a checkout needs: the owner is waiting on the page or sheet it returns.
    outcome = await getSubscriptionProvider(providerName).createCheckout({
      tenantId: context.tenantId, planKey, providerPlanId, ownerEmail: context.userEmail,
      successUrl: `${appOrigin()}/dashboard?billing=success`, cancelUrl: `${appOrigin()}/dashboard?billing=cancelled`,
    });
  } catch (error) {
    throw providerFailure(error);
  }
  await transaction.update(tenantSubscriptions).set({
    provider: providerName,
    // Razorpay's subscription exists now; Stripe's arrives with its webhook. Webhooks name the business by it.
    ...(outcome.providerSubscriptionId ? { providerSubscriptionId: outcome.providerSubscriptionId } : {}),
    ...(outcome.providerCustomerId ? { providerCustomerId: outcome.providerCustomerId } : {}),
    updatedAt: now,
  }).where(eq(tenantSubscriptions.tenantId, context.tenantId));
  await recordBillingAudit(transaction, context, "billing.checkout_started", { planKey, provider: providerName });
  return outcome.result;
}

/** Runs `work` once per Idempotency-Key when the caller sent one; a repeat of the same request returns the stored answer. */
async function once<T>(transaction: KalendrTransaction, context: StaffContext, route: string, key: string | null, request: unknown, work: () => Promise<T>): Promise<T> {
  if (!key) return work();
  const claim = await claimKey<T>(transaction, context.tenantId, route, key, request);
  if ("replay" in claim) return claim.replay;
  const result = await work();
  await finishKey(transaction, claim.claimId, result);
  return result;
}

export async function startCheckout(context: StaffContext, planKey: Paid, idempotencyKey: string | null, now: Date = new Date()): Promise<CheckoutResult> {
  requirePermission(context, "billing.manage");
  refuseInPreview(context);
  return withTenant(context.tenantId, (transaction) => once(transaction, context, "billing.checkout", idempotencyKey, { planKey }, () => startCheckoutIn(transaction, context, planKey, now)));
}

export async function changePlan(context: StaffContext, planKey: PlanKey, idempotencyKey: string | null, now: Date = new Date()): Promise<CheckoutResult> {
  requirePermission(context, "billing.manage");
  refuseInPreview(context);
  return withTenant(context.tenantId, (transaction) => once<CheckoutResult>(transaction, context, "billing.change_plan", idempotencyKey, { planKey }, async () => {
    const run = drizzleRunner(transaction);
    const { subscription } = await loadBilling(run, context.tenantId, { lock: true, now });
    if (!isSubscribed(subscription)) {
      if (planKey !== "free") return startCheckoutIn(transaction, context, planKey, now);
      // Choosing Free before ever paying: the trial just ends now. Nothing to tell a provider.
      await transaction.update(tenantSubscriptions).set({ status: "free", planKey: "free", pendingPlanKey: null, version: subscription.version + 1, updatedAt: now }).where(eq(tenantSubscriptions.tenantId, context.tenantId));
      await recordBillingAudit(transaction, context, "billing.plan_changed", { from: subscription.planKey, to: "free", when: "now" });
      return { kind: "done" };
    }
    if (planKey === "free") {
      await cancelIn(transaction, context, subscription, now);
      return { kind: "done" };
    }
    if (planKey === subscription.planKey) {
      // Choosing the plan already held undoes a scheduled downgrade; the provider is told to keep the price.
      if (subscription.pendingPlanKey) {
        await transaction.update(tenantSubscriptions).set({ pendingPlanKey: null, version: subscription.version + 1, updatedAt: now }).where(eq(tenantSubscriptions.tenantId, context.tenantId));
        await queueProviderChange(transaction, context.tenantId, "downgrade", planKey);
        await recordBillingAudit(transaction, context, "billing.downgrade_cancelled", { plan: planKey });
      }
      return { kind: "done" };
    }
    if (isUpgrade(subscription.planKey, planKey)) {
      const providerPlanId = subscription.provider ? (await providerPlanIds(run, subscription.provider))[planKey] : undefined;
      if (!subscription.provider || !subscription.providerSubscriptionId || !providerPlanId) throw providerFailure(new ProviderNotConfiguredError(subscription.provider ?? "stripe"));
      try {
        await getSubscriptionProvider(subscription.provider).changePlan({ providerSubscriptionId: subscription.providerSubscriptionId, providerPlanId, when: "now", tenantId: context.tenantId, planKey });
      } catch (error) {
        throw providerFailure(error);
      }
      await transaction.update(tenantSubscriptions).set({ planKey, pendingPlanKey: null, cancelAtPeriodEnd: false, version: subscription.version + 1, updatedAt: now }).where(eq(tenantSubscriptions.tenantId, context.tenantId));
      await recordBillingAudit(transaction, context, "billing.plan_changed", { from: subscription.planKey, to: planKey, when: "now" });
      return { kind: "done" };
    }
    // A downgrade is recorded now and takes effect when the paid period ends; the worker tells the provider.
    await transaction.update(tenantSubscriptions).set({ pendingPlanKey: planKey, cancelAtPeriodEnd: false, version: subscription.version + 1, updatedAt: now }).where(eq(tenantSubscriptions.tenantId, context.tenantId));
    await queueProviderChange(transaction, context.tenantId, "downgrade", planKey);
    await recordBillingAudit(transaction, context, "billing.plan_changed", { from: subscription.planKey, to: planKey, when: "period_end" });
    return { kind: "done" };
  }));
}

async function cancelIn(transaction: Transaction, context: StaffContext, subscription: SubscriptionRecord, now: Date): Promise<void> {
  if (!isSubscribed(subscription)) {
    // No payment was ever taken: cancelling is simply ending the trial or staying on Free.
    await transaction.update(tenantSubscriptions).set({ status: "free", planKey: "free", pendingPlanKey: null, version: subscription.version + 1, updatedAt: now }).where(eq(tenantSubscriptions.tenantId, context.tenantId));
    await recordBillingAudit(transaction, context, "billing.cancelled", { when: "now" });
    return;
  }
  await transaction.update(tenantSubscriptions).set({ cancelAtPeriodEnd: true, pendingPlanKey: null, version: subscription.version + 1, updatedAt: now }).where(eq(tenantSubscriptions.tenantId, context.tenantId));
  await queueProviderChange(transaction, context.tenantId, "cancel");
  await recordBillingAudit(transaction, context, "billing.cancel_requested", { endsAt: subscription.currentPeriodEnd?.toISOString() ?? null });
}

/** Cancels at the end of the paid period. Needs a fresh second-factor check: ending a plan is not something a stolen session should do. */
export async function cancelSubscription(context: StaffContext, now: Date = new Date()): Promise<{ cancelAtPeriodEnd: boolean; endsAt: string | null }> {
  requirePermission(context, "billing.manage");
  refuseInPreview(context);
  requireRecentStepUp(context, now);
  return withTenant(context.tenantId, async (transaction) => {
    const { subscription } = await loadBilling(drizzleRunner(transaction), context.tenantId, { lock: true, now });
    await cancelIn(transaction, context, subscription, now);
    return { cancelAtPeriodEnd: isSubscribed(subscription), endsAt: subscription.currentPeriodEnd?.toISOString() ?? null };
  });
}

export async function resumeSubscription(context: StaffContext, now: Date = new Date()): Promise<{ cancelAtPeriodEnd: boolean }> {
  requirePermission(context, "billing.manage");
  refuseInPreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const { subscription } = await loadBilling(drizzleRunner(transaction), context.tenantId, { lock: true, now });
    if (!isSubscribed(subscription) || !subscription.cancelAtPeriodEnd) {
      throw new ApiError(409, "cannot_resume", "There is no cancellation to undo. Choose a plan to start again.");
    }
    await transaction.update(tenantSubscriptions).set({ cancelAtPeriodEnd: false, version: subscription.version + 1, updatedAt: now }).where(eq(tenantSubscriptions.tenantId, context.tenantId));
    await queueProviderChange(transaction, context.tenantId, "resume");
    await recordBillingAudit(transaction, context, "billing.resumed", {});
    return { cancelAtPeriodEnd: false };
  });
}

/** The owner's choice for messages past the plan's allowance, and the GSTIN printed on invoices. `version` guards against a stale screen. */
export async function updateBillingSettings(context: StaffContext, input: z.infer<typeof billingSettingsInputSchema>, now: Date = new Date()): Promise<{ version: number }> {
  requirePermission(context, "billing.manage");
  refuseInPreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const { subscription } = await loadBilling(drizzleRunner(transaction), context.tenantId, { lock: true, now });
    if (input.version !== undefined && input.version !== subscription.version) {
      throw new ApiError(409, "version_conflict", "These settings changed while you were editing. Reload and try again.");
    }
    const version = subscription.version + 1;
    await transaction.update(tenantSubscriptions).set({
      ...(input.overageMode ? { overageMode: input.overageMode } : {}),
      ...(input.billingGstin !== undefined ? { billingGstin: input.billingGstin } : {}),
      version, updatedAt: now,
    }).where(eq(tenantSubscriptions.tenantId, context.tenantId));
    await recordBillingAudit(transaction, context, "billing.settings_changed", {
      ...(input.overageMode ? { overageMode: input.overageMode } : {}),
      ...(input.billingGstin !== undefined ? { gstinChanged: true } : {}),
    });
    return { version };
  });
}

/** Who may read the plan state: the owner and anyone who can manage settings, so the banner and meters work for admins. */
export function requireBillingRead(context: StaffContext): void {
  if (context.permissions.includes("settings.manage")) return;
  requirePermission(context, "billing.manage");
}

/** The Idempotency-Key header when the screen sent one; checkout and plan changes use it to survive a double click. */
export function optionalIdempotencyKey(request: Request): string | null {
  return request.headers.get("idempotency-key") ? getIdempotencyKey(request) : null;
}
