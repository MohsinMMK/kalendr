import "server-only";

import { sql } from "drizzle-orm";

import { requireDatabase, withTenant } from "@/db/client";
import { billingEvents, outboxEvents } from "@/db/schema";

import { getPostgresErrorCode } from "../api-error";
import { currentTraceParent } from "../tracing";
import { BILLING_EVENT, type BillingEventExtract } from "./webhook-events";

export type IntakeOutcome = "queued" | "duplicate" | "dropped";

async function resolveTenant(extract: BillingEventExtract): Promise<string | null> {
  const database = requireDatabase();
  if (extract.providerSubscriptionId) {
    const rows = await database.execute<{ tenant: string | null }>(sql`select kalendr_resolve_subscription_tenant(${extract.provider}, ${extract.providerSubscriptionId}) as tenant`);
    const found = Array.from(rows)[0]?.tenant;
    if (found) return found;
  }
  // Checkout and the first Razorpay events carry the tenant id we put in notes or metadata when we created the subscription.
  if (extract.tenantId) return extract.tenantId;
  if (extract.providerCustomerId) {
    const rows = await database.execute<{ tenant: string | null }>(sql`select kalendr_resolve_customer_tenant(${extract.provider}, ${extract.providerCustomerId}) as tenant`);
    return Array.from(rows)[0]?.tenant ?? null;
  }
  return null;
}

/**
 * Steps three and four of the webhook rule: find the business, then record the event and queue the worker's job in
 * one transaction, doing nothing else. A repeat delivery hits the unique key and queues nothing. An event whose
 * business cannot be found (an old subscription, another environment, a bad id in the notes) is dropped: the caller
 * still answers 200 so the provider stops retrying, and nothing but the provider's event id is ever logged.
 */
export async function intakeBillingEvent(extract: BillingEventExtract): Promise<IntakeOutcome> {
  const tenantId = await resolveTenant(extract);
  if (!tenantId) return "dropped";
  try {
    return await withTenant(tenantId, async (transaction) => {
      const [recorded] = await transaction.insert(billingEvents).values({
        tenantId,
        provider: extract.provider,
        providerEventId: extract.eventId,
        type: extract.type.slice(0, 100),
        payload: { ...extract, tenantId },
      }).onConflictDoNothing().returning({ id: billingEvents.id });
      if (!recorded) return "duplicate" as const;
      await transaction.insert(outboxEvents).values({
        tenantId,
        aggregateType: "billing",
        aggregateId: recorded.id,
        eventType: BILLING_EVENT,
        // Only the row's id travels in the outbox; the worker reads the stored extract.
        payload: { billingEventId: recorded.id },
        dedupeKey: `billing:${extract.provider}:${extract.eventId}`.slice(0, 200),
        traceParent: currentTraceParent(),
      }).onConflictDoNothing();
      return "queued" as const;
    });
  } catch (error) {
    // 23503: the tenant id from the notes names no business.
    if (getPostgresErrorCode(error) === "23503") return "dropped";
    throw error;
  }
}
