import "server-only";

import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { getDatabase, withTenant } from "@/db/client";

import { ApiError } from "../api-error";
import { loadRecordKeys } from "../record-crypto";
import { drizzleRunner } from "../workflows/runner";
import { loadAccountById, openCredentials } from "./credentials";
import { fakeProviderAllowed, signFakeWebhook, FAKE_SIGNATURE_HEADER, type FakeWebhookBody } from "./fake";

export const testCheckoutSchema = z.strictObject({
  orderId: z.string().trim().min(10).max(80),
  outcome: z.enum(["paid", "failed"]),
});

/**
 * The built-in test checkout's button. It does what a real provider does: it sends a body signed with the account's
 * webhook secret to the real webhook route. Nothing here marks anything paid; the worker does that after the webhook.
 * Not available in production.
 */
export async function completeTestCheckout(input: z.infer<typeof testCheckoutSchema>, origin: string): Promise<{ sent: true }> {
  if (!fakeProviderAllowed()) throw new ApiError(404, "not_found", "Not found.");
  const parts = input.orderId.split("_");
  const publicId = parts[0] === "fake" && parts.length === 3 ? parts[1] : null;
  const database = getDatabase();
  if (!publicId || !database) throw new ApiError(404, "order_not_found", "That test payment was not found.");
  const [found] = await database.execute<{ tenant_id: string; account_id: string }>(sql`select tenant_id, account_id from kalendr_resolve_payment_account(${publicId})`);
  if (!found) throw new ApiError(404, "order_not_found", "That test payment was not found.");
  const prepared = await withTenant(found.tenant_id, async (transaction) => {
    await loadRecordKeys(transaction, found.tenant_id);
    const account = await loadAccountById(drizzleRunner(transaction), found.tenant_id, found.account_id);
    const [order] = await transaction.execute<{ amount_minor: number; currency: string }>(sql`
      select amount_minor, currency from payment_orders where tenant_id = ${found.tenant_id} and provider = 'fake' and provider_order_id = ${input.orderId}`);
    if (!account || account.provider !== "fake" || !order) throw new ApiError(404, "order_not_found", "That test payment was not found.");
    return { secret: openCredentials(account).webhookSecret, amountMinor: order.amount_minor, currency: order.currency };
  });
  const body: FakeWebhookBody = input.outcome === "paid"
    ? { id: `evt_${randomBytes(9).toString("hex")}`, type: "payment.captured", orderId: input.orderId, paymentId: `fake_pay_${randomBytes(9).toString("hex")}`, amountMinor: prepared.amountMinor, currency: prepared.currency }
    : { id: `evt_${randomBytes(9).toString("hex")}`, type: "payment.failed", orderId: input.orderId };
  const signed = signFakeWebhook(prepared.secret, body);
  const response = await fetch(`${origin}/api/webhooks/fake/${publicId}`, {
    method: "POST", headers: { "Content-Type": "application/json", [FAKE_SIGNATURE_HEADER]: signed.signature }, body: signed.rawBody,
  });
  if (!response.ok) throw new ApiError(502, "webhook_failed", "The test payment could not be delivered.");
  return { sent: true };
}
