import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import { withTenant } from "@/db/client";
import { auditEvents, platformInvoices, tenants, tenantSubscriptions } from "@/db/schema";
import { billingStateSchema, type BillingInvoice, type BillingState } from "@/lib/billing-contracts";
import { billingCurrency, chooseBillingProvider, planPriceMinor, usagePeriod } from "@/lib/billing-rules";
import { effectivePlanKey, planDefinitions, planKeys, planKeySchema, trialDays, trialPlanKey, type Entitlements } from "@/lib/entitlements";

import { ApiError } from "../api-error";
import { previewEntitlements } from "../entitlements";
import type { StaffContext } from "../staff-context";
import { drizzleRunner, type Runner } from "../workflows/runner";
import { loadBilling } from "./entitlement-loader";
import { checkoutAvailable } from "./providers";

/**
 * Subscription state for the signed-in business (feature 14): creating the trial at sign-up, and the read the
 * "Plan and billing" screen and the banner use. Changes that talk to a provider live in plan-changes.ts.
 */

type Transaction = Pick<KalendrTransaction, "insert" | "execute">;

/** Called by `registerClinic` inside the same transaction that creates the business, so no business ever lacks a subscription. */
export async function createTrialSubscription(transaction: Transaction, tenantId: string, now: Date = new Date()): Promise<void> {
  await transaction.insert(tenantSubscriptions).values({
    tenantId, planKey: trialPlanKey, status: "trialing", trialEndsAt: new Date(now.getTime() + trialDays * 86_400_000),
  }).onConflictDoNothing();
}

export async function recordBillingAudit(transaction: Pick<KalendrTransaction, "insert">, context: Pick<StaffContext, "tenantId" | "userId">, action: string, metadata: Record<string, unknown>): Promise<void> {
  await transaction.insert(auditEvents).values({ tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action, outcome: "success", metadata });
}

function plansView(currency: "INR" | "USD"): BillingState["plans"] {
  return planKeys.map((key) => ({ key, name: planDefinitions[key].name, priceMinor: planPriceMinor(key, currency), currency, limits: planDefinitions[key].limits }));
}

function usageRows(entitlements: Entitlements, counters: Map<string, number>, bookings: number): BillingState["usage"] {
  const whatsapp = entitlements.limits.messagesIncluded.whatsapp;
  const sms = entitlements.limits.messagesIncluded.sms;
  return [
    { metric: "whatsapp", used: counters.get("message:whatsapp") ?? 0, included: whatsapp },
    { metric: "sms", used: counters.get("message:sms") ?? 0, included: sms },
    { metric: "email", used: counters.get("message:email") ?? 0, included: null },
    { metric: "bookings", used: bookings, included: entitlements.limits.bookingsPerMonth },
  ];
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

function invoiceView(row: typeof platformInvoices.$inferSelect): BillingInvoice {
  return {
    id: row.id, invoiceNumber: row.invoiceNumber, issuedAt: row.issuedAt.toISOString(), planKey: planKeySchema.catch("free").parse(row.planKey),
    currency: row.currency, amountMinor: row.amountMinor, gstMinor: row.gstMinor, totalMinor: row.totalMinor,
    kalendrGstin: row.kalendrGstin, buyerGstin: row.buyerGstin,
  };
}

async function readCounters(run: Runner, tenantId: string, now: Date): Promise<{ counters: Map<string, number>; bookings: number }> {
  const rows = await run(sql`select metric, count from usage_counters where tenant_id = ${tenantId} and period = ${usagePeriod(now)}::date`);
  const counters = new Map(rows.map((row) => [String(row.metric), Number(row.count)]));
  const [booked] = await run(sql`select count(*)::int as count from appointments where tenant_id = ${tenantId} and created_at >= ${usagePeriod(now)}::date and status <> 'entered_in_error'`);
  return { counters, bookings: Number(booked?.count ?? 0) };
}

/** The demo state shown in preview mode: a Growth trial and honest empty history. Checkout is unavailable there. */
export function previewBillingState(now: Date = new Date()): BillingState {
  const entitlements = previewEntitlements(now);
  return billingStateSchema.parse({
    plan: { key: entitlements.planKey, name: entitlements.planName, status: entitlements.status, reason: "trial", trialEndsAt: iso(entitlements.trialEndsAt), graceEndsAt: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, pendingPlanKey: null },
    provider: null, checkoutProvider: "razorpay", currency: "INR", plans: plansView("INR"),
    usage: usageRows(entitlements, new Map([["message:whatsapp", 42], ["message:sms", 12], ["message:email", 310]]), 38),
    overageMode: "stop_marketing", billingGstin: null, invoices: [], banner: null, checkoutAvailable: false,
  });
}

export async function getBillingState(context: StaffContext, now: Date = new Date()): Promise<BillingState> {
  if (context.preview) return previewBillingState(now);
  return withTenant(context.tenantId, async (transaction) => {
    const run = drizzleRunner(transaction);
    const { subscription, entitlements } = await loadBilling(run, context.tenantId, { now });
    const [tenant] = await transaction.select({ currency: tenants.currency, locale: tenants.locale, timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, context.tenantId)).limit(1);
    const checkoutProvider = chooseBillingProvider({ currency: tenant?.currency ?? "INR", locale: tenant?.locale ?? "en-IN", timezone: tenant?.timezone ?? "Asia/Kolkata" });
    const currency = billingCurrency(checkoutProvider);
    const { counters, bookings } = await readCounters(run, context.tenantId, now);
    const invoices = await transaction.select().from(platformInvoices).where(eq(platformInvoices.tenantId, context.tenantId)).orderBy(desc(platformInvoices.issuedAt)).limit(24);
    const reason = effectivePlanKey({ ...subscription }, now).reason;
    const inGrace = subscription.status === "past_due" && entitlements.graceEndsAt !== null && entitlements.graceEndsAt > now;
    return billingStateSchema.parse({
      plan: {
        key: entitlements.planKey, name: entitlements.planName, status: subscription.status, reason,
        trialEndsAt: iso(subscription.trialEndsAt), graceEndsAt: iso(entitlements.graceEndsAt), currentPeriodEnd: iso(subscription.currentPeriodEnd),
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd, pendingPlanKey: subscription.pendingPlanKey,
      },
      provider: subscription.provider, checkoutProvider, currency, plans: plansView(currency), usage: usageRows(entitlements, counters, bookings),
      overageMode: subscription.overageMode, billingGstin: subscription.billingGstin, invoices: invoices.map(invoiceView),
      // The banner is for owners only; everyone else on the team just keeps working.
      banner: context.role === "owner" && inGrace && entitlements.graceEndsAt ? { kind: "past_due", graceEndsAt: entitlements.graceEndsAt.toISOString() } : null,
      checkoutAvailable: await checkoutAvailable(run, checkoutProvider),
    });
  });
}

export async function getBillingInvoice(context: StaffContext, invoiceId: string): Promise<BillingInvoice> {
  if (context.preview) throw new ApiError(404, "invoice_not_found", "Invoice not found.");
  const row = await withTenant(context.tenantId, async (transaction) => (await transaction.select().from(platformInvoices)
    .where(and(eq(platformInvoices.tenantId, context.tenantId), eq(platformInvoices.id, invoiceId))).limit(1))[0]);
  if (!row) throw new ApiError(404, "invoice_not_found", "Invoice not found.");
  return invoiceView(row);
}

export async function listBillingInvoices(context: StaffContext): Promise<BillingInvoice[]> {
  if (context.preview) return [];
  const rows = await withTenant(context.tenantId, (transaction) => transaction.select().from(platformInvoices)
    .where(eq(platformInvoices.tenantId, context.tenantId)).orderBy(desc(platformInvoices.issuedAt)).limit(200));
  return rows.map(invoiceView);
}
