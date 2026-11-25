import "server-only";

import { sql } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import {
  amountDueNow, defaultPaymentPolicy, policyWording,
  type PaymentPolicy, type PaymentTermsSnapshot, type PublicServicePayment, type ServicePaymentMode,
} from "@/lib/payments";
import { profileWords } from "@/lib/terminology";

import { loadBusinessProfileIn } from "../business-profile";

export interface PaymentQuote {
  payment: PublicServicePayment;
  terms: PaymentTermsSnapshot;
  policy: PaymentPolicy;
}

export async function loadPolicyIn(transaction: KalendrTransaction, tenantId: string): Promise<PaymentPolicy> {
  const [row] = await transaction.execute<{ free_cancel_hours: number; after_window_rule: PaymentPolicy["afterWindowRule"]; no_show_rule: PaymentPolicy["noShowRule"]; version: number }>(sql`
    select free_cancel_hours, after_window_rule, no_show_rule, version from tenant_payment_policies where tenant_id = ${tenantId}`);
  return row
    ? { freeCancelHours: row.free_cancel_hours, afterWindowRule: row.after_window_rule, noShowRule: row.no_show_rule, version: row.version }
    : defaultPaymentPolicy;
}

interface QuoteContext {
  currency: string;
  hasAccount: boolean;
  policy: PaymentPolicy;
  visitWord: string;
}

async function loadContext(transaction: KalendrTransaction, tenantId: string): Promise<QuoteContext> {
  const [tenant] = await transaction.execute<{ currency: string; has_account: boolean }>(sql`
    select tenant.currency,
      exists (select 1 from tenant_payment_accounts as account where account.tenant_id = tenant.id and account.status = 'active') as has_account
    from tenants as tenant where tenant.id = ${tenantId}`);
  return {
    currency: tenant?.currency ?? "INR",
    hasAccount: tenant?.has_account ?? false,
    policy: await loadPolicyIn(transaction, tenantId),
    visitWord: profileWords(await loadBusinessProfileIn(transaction, tenantId)).appointment,
  };
}

function buildQuote(
  context: QuoteContext,
  service: { mode: ServicePaymentMode; priceMinor: number | null; depositMinor: number | null },
  now: Date,
): PaymentQuote | null {
  if (service.mode === "none" || !context.hasAccount) return null;
  if (service.priceMinor === null || service.priceMinor <= 0) return null;
  const { dueNowMinor, dueLaterMinor } = amountDueNow(service);
  if (dueNowMinor <= 0) return null;
  // A deposit as large as the price is simply the whole price.
  const mode: Exclude<ServicePaymentMode, "none"> = service.mode === "deposit" && dueLaterMinor > 0 ? "deposit" : "full";
  const depositMinor = mode === "deposit" ? dueNowMinor : null;
  const policyText = policyWording(context.policy, { mode, depositMinor, dueNowMinor, currency: context.currency }, context.visitWord);
  return {
    payment: { mode, priceMinor: service.priceMinor, depositMinor, dueNowMinor, dueLaterMinor, currency: context.currency, policyText },
    policy: context.policy,
    terms: {
      mode, priceMinor: service.priceMinor, depositMinor, dueNowMinor, currency: context.currency,
      freeCancelHours: context.policy.freeCancelHours, afterWindowRule: context.policy.afterWindowRule, noShowRule: context.policy.noShowRule, agreedAt: now.toISOString(),
    },
  };
}

/**
 * What a booking of this service costs online right now, worked out on the server from the service and the
 * business's rules. Null when nothing is asked for online: the service takes no payment, has no price, or the
 * business has no working payment account. `priceMinorOverride` is the price of the chosen length when it has its own.
 */
export async function quoteService(
  transaction: KalendrTransaction,
  tenantId: string,
  serviceId: string,
  priceMinorOverride: number | null = null,
  now: Date = new Date(),
): Promise<PaymentQuote | null> {
  const [service] = await transaction.execute<{ payment_mode: ServicePaymentMode; price_minor: number | null; deposit_minor: number | null }>(sql`
    select payment_mode, price_minor, deposit_minor from services where tenant_id = ${tenantId} and id = ${serviceId}`);
  if (!service || service.payment_mode === "none") return null;
  return buildQuote(await loadContext(transaction, tenantId), { mode: service.payment_mode, priceMinor: priceMinorOverride ?? service.price_minor, depositMinor: service.deposit_minor }, now);
}

/** The payment shown on each service of the public catalog, in one pass. */
export async function quoteCatalog(transaction: KalendrTransaction, tenantId: string): Promise<Map<string, PublicServicePayment>> {
  const rows = await transaction.execute<{ id: string; payment_mode: ServicePaymentMode; price_minor: number | null; deposit_minor: number | null }>(sql`
    select id, payment_mode, price_minor, deposit_minor from services where tenant_id = ${tenantId} and payment_mode <> 'none'`);
  const quotes = new Map<string, PublicServicePayment>();
  if (rows.length === 0) return quotes;
  const context = await loadContext(transaction, tenantId);
  const now = new Date();
  for (const row of rows) {
    const quote = buildQuote(context, { mode: row.payment_mode, priceMinor: row.price_minor, depositMinor: row.deposit_minor }, now);
    if (quote) quotes.set(row.id, quote.payment);
  }
  return quotes;
}

/** What a booking was made to pay, read back from the terms stored on it. Null when it has none. */
export function storedPayment(terms: Record<string, unknown> | null | undefined, text: string | null | undefined): PublicServicePayment | null {
  if (!terms) return null;
  const { mode, priceMinor, depositMinor, dueNowMinor, currency } = terms as Partial<PaymentTermsSnapshot>;
  if ((mode !== "deposit" && mode !== "full") || typeof priceMinor !== "number" || typeof dueNowMinor !== "number" || typeof currency !== "string") return null;
  return { mode, priceMinor, depositMinor: depositMinor ?? null, dueNowMinor, dueLaterMinor: Math.max(0, priceMinor - dueNowMinor), currency, policyText: text ?? "" };
}
