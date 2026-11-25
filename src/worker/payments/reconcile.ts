import { sql } from "drizzle-orm";
import { z } from "zod";

import { loadAccount, openCredentials } from "../../server/payments/credentials";
import { providerFor, type ProviderEnvironment } from "../../server/payments/index";
import { ProviderError } from "../../server/payments/types";
import { postgresDataKeyStore } from "../../server/keys/postgres-store";
import { loadDataKeys } from "../../server/keys/ring";
import { asNumber, asString, postgresRunner } from "../../server/workflows/runner";
import type { EventHandler } from "../handlers/types";

export const RECONCILE_EVENT = "payment.reconcile";

const payloadSchema = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/** The previous whole day (UTC) the night's run looks at: the run is queued after midnight UTC, so "yesterday". */
export function reconcileWindow(today: string): { from: Date; to: Date; day: string } {
  const to = new Date(`${today}T00:00:00.000Z`);
  const from = new Date(to.getTime() - 86_400_000);
  return { from, to, day: from.toISOString().slice(0, 10) };
}

/**
 * The nightly check that catches a missed webhook. Fetches the provider's payments for yesterday and compares them with the
 * ledger by provider payment id. Differences go to the owner's list; nothing is changed automatically.
 */
export function reconcileHandler(environment: ProviderEnvironment): EventHandler {
  return async (tenantDb, event) => {
    const payload = payloadSchema.safeParse(event.payload);
    if (!payload.success) return { outcome: "dead", code: "invalid_reconcile_event" };
    const run = postgresRunner(tenantDb);
    const account = await loadAccount(run, event.tenantId);
    if (!account || account.status !== "active" || account.provider === "fake") return "delivered";
    await loadDataKeys(postgresDataKeyStore(tenantDb), event.tenantId);
    const credentials = account.provider === "stripe" ? { keyId: account.keyId, keySecret: "", webhookSecret: "" } : openCredentials(account);
    const window = reconcileWindow(payload.data.day);
    let remote;
    try {
      remote = await providerFor(account.provider, environment).listPayments(credentials, window);
    } catch (error: unknown) {
      if (error instanceof ProviderError && error.retryable) return { outcome: "retry", code: error.code };
      return { outcome: "dead", code: error instanceof ProviderError ? error.code : "reconcile_failed" };
    }
    const ledger = await run(sql`
      select provider_payment_id, amount_minor from payments
      where tenant_id = ${event.tenantId} and provider = ${account.provider} and created_at >= ${window.from.toISOString()}::timestamptz and created_at < ${window.to.toISOString()}::timestamptz`);
    const known = new Map(ledger.map((row) => [asString(row.provider_payment_id), asNumber(row.amount_minor)]));
    const seen = new Set<string>();
    const note = async (kind: string, id: string, providerAmount: number | null, ledgerAmount: number | null) => {
      await run(sql`
        insert into payment_mismatches (tenant_id, account_id, day, kind, provider_payment_id, provider_amount_minor, ledger_amount_minor)
        values (${event.tenantId}, ${account.id}, ${window.day}::date, ${kind}, ${id}, ${providerAmount}, ${ledgerAmount}) on conflict do nothing`);
    };
    // Everything the provider lists is accounted for here, refunded ones included; only captured ones are compared.
    for (const payment of remote) seen.add(payment.providerPaymentId);
    for (const payment of remote.filter((item) => item.captured)) {
      const here = known.get(payment.providerPaymentId);
      if (here === undefined) {
        const [anywhere] = await run(sql`select amount_minor from payments where tenant_id = ${event.tenantId} and provider = ${account.provider} and provider_payment_id = ${payment.providerPaymentId}`);
        if (!anywhere) await note("missing_here", payment.providerPaymentId, payment.amountMinor, null);
      } else if (here !== payment.amountMinor) {
        await note("amount_differs", payment.providerPaymentId, payment.amountMinor, here);
      }
    }
    for (const [id, amount] of known) if (!seen.has(id)) await note("missing_at_provider", id, null, amount);
    return "delivered";
  };
}
