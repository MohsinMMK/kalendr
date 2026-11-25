import "server-only";

import { sql } from "drizzle-orm";

import { getDatabase, withTenant } from "@/db/client";
import { outboxEvents, paymentEvents } from "@/db/schema";
import type { PaymentProviderId } from "@/lib/payments";

import { ApiError } from "../api-error";
import { env } from "../env";
import { loadRecordKeys } from "../record-crypto";
import { currentTraceParent } from "../tracing";
import { drizzleRunner } from "../workflows/runner";
import { loadAccountById, openCredentials } from "./credentials";
import { providerFor } from "./index";
import { stripeEventAccount } from "./stripe";
import { MAX_WEBHOOK_BYTES, WebhookSignatureError, type ProviderCredentials } from "./types";

export const PAYMENT_EVENT = "payment.event";

export type WebhookResult = "queued" | "duplicate" | "ignored";

interface Resolved {
  tenantId: string;
  accountId: string;
  provider: PaymentProviderId;
}

async function resolveAccount(provider: PaymentProviderId, rawBody: string, publicId: string | null): Promise<Resolved | null> {
  const database = getDatabase();
  if (!database) throw new ApiError(503, "database_unavailable", "Payments are not available right now.");
  const rows = provider === "stripe"
    ? await (async () => {
      const account = stripeEventAccount(rawBody);
      return account ? database.execute<{ tenant_id: string; account_id: string; provider: string }>(sql`select tenant_id, account_id, provider from kalendr_resolve_stripe_account(${account})`) : [];
    })()
    : publicId ? await database.execute<{ tenant_id: string; account_id: string; provider: string }>(sql`select tenant_id, account_id, provider from kalendr_resolve_payment_account(${publicId})`) : [];
  const row = rows[0];
  if (!row || row.provider !== provider) return null;
  return { tenantId: row.tenant_id, accountId: row.account_id, provider };
}

/** The raw body is read before parsing, and refused when it is far larger than any provider sends. */
export async function readRawBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_WEBHOOK_BYTES) throw new ApiError(413, "request_too_large", "The request is too large.");
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > MAX_WEBHOOK_BYTES) throw new ApiError(413, "request_too_large", "The request is too large.");
  return rawBody;
}

/**
 * The five steps every webhook takes: the raw body, the signature, the dedupe on the provider's event id, the
 * event and its outbox row written together, and a fast answer. The worker (`payment.event`) does the rest.
 * An unknown address or a bad signature is the same 401, so nobody can learn which businesses exist.
 */
export async function receiveWebhook(provider: PaymentProviderId, publicId: string | null, rawBody: string, headers: Headers): Promise<WebhookResult> {
  const resolved = await resolveAccount(provider, rawBody, publicId);
  if (!resolved) throw new WebhookSignatureError();
  const config = env();
  return withTenant(resolved.tenantId, async (transaction) => {
    await loadRecordKeys(transaction, resolved.tenantId);
    const account = await loadAccountById(drizzleRunner(transaction), resolved.tenantId, resolved.accountId);
    if (!account || account.status !== "active") throw new WebhookSignatureError();
    const credentials: ProviderCredentials = provider === "stripe"
      ? { keyId: account.keyId, keySecret: "", webhookSecret: config.STRIPE_CONNECT_WEBHOOK_SECRET ?? "" }
      : openCredentials(account);
    if (!credentials.webhookSecret) throw new WebhookSignatureError();
    const event = providerFor(provider, { stripeSecretKey: config.STRIPE_CONNECT_SECRET_KEY }).parseWebhook(credentials, rawBody, headers);
    if (event.kind === "ignored") return "ignored";
    const inserted = await transaction.insert(paymentEvents).values({
      tenantId: resolved.tenantId, accountId: resolved.accountId, provider, providerEventId: event.eventId, type: event.kind, payload: { ...event },
    }).onConflictDoNothing().returning({ id: paymentEvents.id });
    const row = inserted[0];
    if (!row) return "duplicate";
    await transaction.insert(outboxEvents).values({
      tenantId: resolved.tenantId, aggregateType: "payment_event", aggregateId: row.id, eventType: PAYMENT_EVENT,
      payload: { paymentEventId: row.id }, dedupeKey: `payment.event:${provider}:${event.eventId}`.slice(0, 200), traceParent: currentTraceParent(),
    }).onConflictDoNothing();
    return "queued";
  });
}
