import { assertPriceNotLocked } from "@/server/service-template-locks";
import "server-only";

import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditEvents } from "@/db/schema";
import {
  type MismatchView, type PaymentAccountInput, type PaymentAccountView, type PaymentPolicy, type PaymentPolicyInput,
  type PaymentSettingsView, type ServicePayment, type ServicePaymentInput, amountDueNow,
} from "@/lib/payments";

import { ApiError } from "../api-error";
import { env } from "../env";
import { sealSecret, secretKeyVersion } from "../keys/secrets";
import { loadRecordKeys } from "../record-crypto";
import { isPreviewMode } from "../preview-repository";
import { requireFeature } from "../entitlements";
import { requirePermission, requireRecentStepUp, type StaffContext } from "../staff-context";
import { drizzleRunner } from "../workflows/runner";
import { loadAccount, PAYMENT_SECRET_PURPOSE, PAYMENT_WEBHOOK_PURPOSE } from "./credentials";
import { fakeProviderAllowed } from "./fake";
import { providerFor } from "./index";
import { ProviderError } from "./types";
import { loadPolicyIn } from "./quote";

function refusePreview(context: StaffContext): void {
  if (context.preview || isPreviewMode()) throw new ApiError(409, "preview_only", "Online payments can't be set up in the preview.");
}

export function stripeAvailable(): boolean {
  const config = env();
  return Boolean(config.STRIPE_CONNECT_CLIENT_ID && config.STRIPE_CONNECT_SECRET_KEY && config.STRIPE_CONNECT_WEBHOOK_SECRET);
}

/** Where the provider should send webhooks for this account. Stripe has one platform address; the others have one per business. */
export function webhookUrl(origin: string, provider: string, publicId: string): string {
  return provider === "stripe" ? `${origin}/api/webhooks/stripe` : `${origin}/api/webhooks/${provider}/${publicId}`;
}

export function appOrigin(request: Request): string {
  const configured = env().BETTER_AUTH_URL ?? env().NEXT_PUBLIC_APP_URL;
  return (configured ?? new URL(request.url).origin).replace(/\/$/, "");
}

export function accountView(account: NonNullable<Awaited<ReturnType<typeof loadAccount>>>, origin: string): PaymentAccountView {
  return {
    provider: account.provider, mode: account.mode, status: account.status, keyId: account.keyId,
    webhookUrl: webhookUrl(origin, account.provider, account.publicId), lastCheckedAt: account.lastCheckedAt?.toISOString() ?? null,
  };
}

export async function getPaymentSettings(context: StaffContext, origin: string): Promise<PaymentSettingsView> {
  requirePermission(context, "payments.settings");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const account = await loadAccount(drizzleRunner(transaction), context.tenantId);
    return {
      account: account && account.status === "active" ? accountView(account, origin) : null,
      policy: await loadPolicyIn(transaction, context.tenantId),
      providers: { razorpay: true, stripe: stripeAvailable(), fake: fakeProviderAllowed() },
    };
  });
}

/** Razorpay says which mode a key is in by its prefix. */
export function razorpayModeOf(keyId: string): "test" | "live" {
  return keyId.startsWith("rzp_live_") ? "live" : "test";
}

function providerFailure(error: unknown): never {
  if (error instanceof ProviderError) {
    if (error.code === "provider_rejected_keys") throw new ApiError(400, "provider_rejected_keys", "The payment provider did not accept those keys. Check the key id and secret and try again.");
    throw new ApiError(502, "provider_unavailable", "We couldn't reach the payment provider just now. Please try again in a minute.");
  }
  throw error;
}

/**
 * Connects the business's own payment account. The keys are tried with one harmless call before anything is
 * saved, then sealed with the business's key. Changing this needs a recent second-factor check, because whoever
 * controls it controls where customer money goes.
 */
export async function connectPaymentAccount(context: StaffContext, input: PaymentAccountInput, origin: string): Promise<PaymentAccountView> {
  requirePermission(context, "payments.settings");
  requireFeature(context, "onlinePayments");
  refusePreview(context);
  // The built-in test account moves no money, so it needs no second-factor check. Real keys do.
  if (input.provider !== "fake") requireRecentStepUp(context);
  let keyId: string;
  let secret: string | null;
  let webhookSecret: string;
  let mode: "test" | "live";
  if (input.provider === "fake") {
    if (!fakeProviderAllowed()) throw new ApiError(400, "provider_unavailable", "The built-in test account isn't available here.");
    keyId = "fake_test_account";
    secret = null;
    webhookSecret = randomBytes(32).toString("hex");
    mode = "test";
  } else {
    keyId = input.keyId;
    secret = input.keySecret;
    webhookSecret = input.webhookSecret;
    mode = razorpayModeOf(input.keyId);
    try {
      await providerFor("razorpay").verifyAccount({ keyId, keySecret: input.keySecret, webhookSecret });
    } catch (error: unknown) {
      providerFailure(error);
    }
  }
  return saveAccount(context, { provider: input.provider, keyId, secret, webhookSecret, mode }, origin);
}

export async function saveAccount(
  context: StaffContext,
  account: { provider: "razorpay" | "stripe" | "fake"; keyId: string; secret: string | null; webhookSecret: string | null; mode: "test" | "live" },
  origin: string,
): Promise<PaymentAccountView> {
  return withTenant(context.tenantId, async (transaction) => {
    await loadRecordKeys(transaction, context.tenantId, { forWrite: true });
    const sealedSecret = account.secret ? sealSecret(context.tenantId, PAYMENT_SECRET_PURPOSE, account.secret) : null;
    const sealedWebhook = account.webhookSecret ? sealSecret(context.tenantId, PAYMENT_WEBHOOK_PURPOSE, account.webhookSecret) : null;
    const keyVersion = secretKeyVersion(sealedSecret ?? sealedWebhook ?? sealSecret(context.tenantId, PAYMENT_SECRET_PURPOSE, "x"));
    await transaction.execute(sql`
      insert into tenant_payment_accounts (tenant_id, provider, mode, status, key_id, secret_ciphertext, webhook_secret_ciphertext, key_version, public_id, last_checked_at)
      values (${context.tenantId}, ${account.provider}, ${account.mode}, 'active', ${account.keyId}, ${sealedSecret}, ${sealedWebhook}, ${keyVersion}, ${randomBytes(24).toString("hex")}, now())
      on conflict (tenant_id) do update set provider = excluded.provider, mode = excluded.mode, status = 'active', key_id = excluded.key_id,
        secret_ciphertext = excluded.secret_ciphertext, webhook_secret_ciphertext = excluded.webhook_secret_ciphertext,
        key_version = excluded.key_version, last_checked_at = now(), updated_at = now()`);
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "payments.account_connected", outcome: "success",
      metadata: { provider: account.provider, mode: account.mode },
    });
    const saved = await loadAccount(drizzleRunner(transaction), context.tenantId);
    if (!saved) throw new ApiError(500, "payment_account_missing", "The payment account could not be saved.");
    return accountView(saved, origin);
  });
}

/** Turns online payment off and forgets the keys. Money already taken stays in the ledger. */
export async function disconnectPaymentAccount(context: StaffContext): Promise<void> {
  requirePermission(context, "payments.settings");
  refusePreview(context);
  requireRecentStepUp(context);
  await withTenant(context.tenantId, async (transaction) => {
    await transaction.execute(sql`
      update tenant_payment_accounts set status = 'disabled', secret_ciphertext = null, webhook_secret_ciphertext = null, updated_at = now()
      where tenant_id = ${context.tenantId}`);
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "payments.account_disconnected", outcome: "success", metadata: {},
    });
  });
}

export async function savePaymentPolicy(context: StaffContext, input: PaymentPolicyInput): Promise<PaymentPolicy> {
  requirePermission(context, "payments.settings");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const [existing] = await transaction.execute<{ version: number }>(sql`select version from tenant_payment_policies where tenant_id = ${context.tenantId} for update`);
    if (existing && input.version !== undefined && input.version !== existing.version) {
      throw new ApiError(409, "version_conflict", "Someone else changed the policy. Reload to see their version, then save again.");
    }
    await transaction.execute(sql`
      insert into tenant_payment_policies (tenant_id, free_cancel_hours, after_window_rule, no_show_rule)
      values (${context.tenantId}, ${input.freeCancelHours}, ${input.afterWindowRule}, ${input.noShowRule})
      on conflict (tenant_id) do update set free_cancel_hours = excluded.free_cancel_hours, after_window_rule = excluded.after_window_rule,
        no_show_rule = excluded.no_show_rule, version = tenant_payment_policies.version + 1, updated_at = now()`);
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "payments.policy_changed", outcome: "success",
      metadata: { freeCancelHours: input.freeCancelHours, afterWindowRule: input.afterWindowRule, noShowRule: input.noShowRule },
    });
    return loadPolicyIn(transaction, context.tenantId);
  });
}

/** Price, payment mode and deposit of one service. Bookings already made keep the terms they were made under. */
export async function saveServicePayment(context: StaffContext, serviceId: string, input: ServicePaymentInput): Promise<ServicePayment> {
  requirePermission(context, "payments.settings");
  // A price alone is fine on any plan; asking for money online is a paid feature.
  if (input.paymentMode !== "none") requireFeature(context, "onlinePayments");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const [service] = await transaction.execute<{ id: string }>(sql`select id from services where tenant_id = ${context.tenantId} and id = ${serviceId} for update`);
    if (!service) throw new ApiError(404, "service_not_found", "Service not found.");
    await assertPriceNotLocked(transaction, context.tenantId, serviceId, input.priceMinor); // a template may own the price (feature 48)
    const depositMinor = input.paymentMode === "deposit" ? input.depositMinor : null;
    await transaction.execute(sql`
      update services set price_minor = ${input.priceMinor}, payment_mode = ${input.paymentMode}, deposit_minor = ${depositMinor},
        version = version + 1, updated_at = now()
      where tenant_id = ${context.tenantId} and id = ${serviceId}`);
    // The usual length carries the price shown on the booking page, so it moves with it.
    await transaction.execute(sql`
      update service_durations set price_minor = ${input.priceMinor}
      where tenant_id = ${context.tenantId} and service_id = ${serviceId} and is_default`);
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "payments.service_priced", outcome: "success",
      metadata: { serviceId, paymentMode: input.paymentMode, priceMinor: input.priceMinor, depositMinor },
    });
    const [tenant] = await transaction.execute<{ currency: string }>(sql`select currency from tenants where id = ${context.tenantId}`);
    const due = amountDueNow({ mode: input.paymentMode, priceMinor: input.priceMinor, depositMinor });
    return { mode: input.paymentMode, priceMinor: input.priceMinor, depositMinor, ...due, currency: tenant?.currency ?? "INR" };
  });
}

export async function listMismatches(context: StaffContext): Promise<MismatchView[]> {
  requirePermission(context, "payments.settings");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.execute<{ id: string; day: string; kind: MismatchView["kind"]; provider_payment_id: string; provider_amount_minor: number | null; ledger_amount_minor: number | null; resolved_at: Date | null }>(sql`
      select id, day::text as day, kind, provider_payment_id, provider_amount_minor, ledger_amount_minor, resolved_at
      from payment_mismatches where tenant_id = ${context.tenantId}
      order by (resolved_at is not null), day desc, created_at desc limit 100`);
    return rows.map((row): MismatchView => ({
      id: row.id, day: row.day, kind: row.kind, providerPaymentId: row.provider_payment_id,
      providerAmountMinor: row.provider_amount_minor, ledgerAmountMinor: row.ledger_amount_minor, resolved: row.resolved_at !== null,
    }));
  });
}

export async function resolveMismatch(context: StaffContext, mismatchId: string): Promise<void> {
  requirePermission(context, "payments.settings");
  refusePreview(context);
  await withTenant(context.tenantId, async (transaction) => {
    const updated = await transaction.execute(sql`
      update payment_mismatches set resolved_at = now(), resolved_by_user_id = ${context.userId}
      where tenant_id = ${context.tenantId} and id = ${mismatchId} and resolved_at is null returning id`);
    if (updated.length === 0) throw new ApiError(404, "mismatch_not_found", "That item was not found or is already cleared.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "payments.mismatch_resolved", outcome: "success", metadata: { mismatchId },
    });
  });
}


export async function getServicePayment(context: StaffContext, serviceId: string): Promise<ServicePayment> {
  requirePermission(context, "payments.settings");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.execute<{ payment_mode: ServicePayment["mode"]; price_minor: number | null; deposit_minor: number | null; currency: string }>(sql`
      select service.payment_mode, service.price_minor, service.deposit_minor, tenant.currency
      from services as service join tenants as tenant on tenant.id = service.tenant_id
      where service.tenant_id = ${context.tenantId} and service.id = ${serviceId}`);
    if (!row) throw new ApiError(404, "service_not_found", "Service not found.");
    return { mode: row.payment_mode, priceMinor: row.price_minor, depositMinor: row.deposit_minor, currency: row.currency, ...amountDueNow({ mode: row.payment_mode, priceMinor: row.price_minor, depositMinor: row.deposit_minor }) };
  });
}
