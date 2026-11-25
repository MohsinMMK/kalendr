import { z } from "zod";

import { postgresRunner } from "../../server/workflows/runner";
import { applyMembershipEvent } from "../../server/offers/memberships-core";
import { applyCapture } from "./capture";
import { applyRefundProcessed } from "./refund";
import type { EventHandler } from "../handlers/types";

const REFUND_WAIT_ATTEMPTS = 5;

const payloadSchema = z.object({ paymentEventId: z.string().min(1).max(64) });

/**
 * One webhook event the route stored. The route did nothing but check the signature and write the row; everything that
 * changes money or a booking happens here, in the worker, so a slow database never makes a provider retry.
 */
export function paymentEventHandler(now: () => Date): EventHandler {
  return async (tenantDb, event) => {
    const payload = payloadSchema.safeParse(event.payload);
    if (!payload.success) return { outcome: "dead", code: "invalid_payment_event" };
    const [stored] = await tenantDb<{ account_id: string; provider: string; payload: unknown }[]>`
      select account_id, provider, payload from payment_events where tenant_id = ${event.tenantId} and id = ${payload.data.paymentEventId}`;
    if (!stored) return "delivered";
    const body = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("payment.captured"), providerOrderId: z.string(), providerPaymentId: z.string(), amountMinor: z.number().int(), currency: z.string(), method: z.enum(["upi", "card", "bank", "other"]) }),
      z.object({ kind: z.literal("refund.processed"), providerPaymentId: z.string(), providerRefundId: z.string(), amountMinor: z.number().int() }),
      z.object({ kind: z.literal("payment.failed") }),
      z.object({ kind: z.literal("subscription.renewed"), eventId: z.string(), providerSubscriptionId: z.string(), periodStart: z.string(), periodEnd: z.string(), amountMinor: z.number().int(), method: z.enum(["upi", "card", "bank", "other"]) }),
      z.object({ kind: z.literal("subscription.payment_failed"), eventId: z.string(), providerSubscriptionId: z.string() }),
      z.object({ kind: z.literal("subscription.ended"), eventId: z.string(), providerSubscriptionId: z.string(), reason: z.enum(["cancelled", "paused"]) }),
    ]).safeParse(stored.payload);
    if (!body.success) return "delivered";
    if (body.data.kind === "payment.captured") {
      await applyCapture(tenantDb, event.tenantId, stored.account_id, { provider: stored.provider, ...body.data }, now());
    } else if (body.data.kind === "refund.processed") {
      const lastTry = event.attemptCount >= REFUND_WAIT_ATTEMPTS;
      const applied = await applyRefundProcessed(tenantDb, event.tenantId, stored.account_id, { provider: stored.provider, ...body.data }, lastTry);
      // A few tries (about a minute and a quarter) covers a capture that arrives late or a refund of ours still in flight;
      // after that it is a payment Kalendr never took (an account also used elsewhere), and is let go.
      if (applied === "not_yet" && !lastTry) return { outcome: "retry", code: "refund_waiting" };
    } else if (body.data.kind === "subscription.renewed" || body.data.kind === "subscription.payment_failed" || body.data.kind === "subscription.ended") {
      // Memberships (feature 25): the same rules run for a provider's renewal as for one the desk records.
      const run = postgresRunner(tenantDb);
      const ref = { tenantId: event.tenantId, provider: stored.provider, providerSubscriptionId: body.data.providerSubscriptionId, eventId: body.data.eventId };
      if (body.data.kind === "subscription.renewed") {
        await applyMembershipEvent(run, ref, { kind: "renewed", periodStart: new Date(body.data.periodStart), periodEnd: new Date(body.data.periodEnd), amountMinor: body.data.amountMinor, method: body.data.method }, now());
      } else if (body.data.kind === "subscription.payment_failed") {
        await applyMembershipEvent(run, ref, { kind: "payment_failed" }, now());
      } else {
        await applyMembershipEvent(run, ref, { kind: "ended", reason: body.data.reason }, now());
      }
    }
    // A failed attempt changes nothing: the customer may try again on the same order, and an unpaid hold simply runs out.
    return "delivered";
  };
}
