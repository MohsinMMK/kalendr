import { appOrigin } from "../../server/env";
import { loadBilling } from "../../server/billing/entitlement-loader";
import { ProviderNotConfiguredError } from "../../server/billing/provider";
import { getSubscriptionProvider, providerPlanIds } from "../../server/billing/providers";
import { processBillingEvent } from "../../server/billing/worker-apply";
import { postgresRunner } from "../../server/workflows/runner";
import { planKeySchema, pastDueGraceDays } from "../../lib/entitlements";
import { deliveryToHandlerOutcome, type HandlerDependencies } from "./appointment-message";
import type { EventHandler, TenantDb } from "./types";

import { z } from "zod";

const eventPayload = z.object({ billingEventId: z.string().min(1).max(100) });

/** Applies one stored provider event (queued by the webhook route) to the business's subscription. */
export function billingEventHandler({ now }: Pick<HandlerDependencies, "now">): EventHandler {
  return async (tenantDb, event) => {
    const payload = eventPayload.safeParse(event.payload);
    if (!payload.success) return { outcome: "dead", code: "invalid_payload" };
    await processBillingEvent(tenantDb, event.tenantId, payload.data.billingEventId, now());
    return "delivered";
  };
}

const emailPayload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("payment_failed") }),
  z.object({ kind: z.literal("subscription_started"), planKey: planKeySchema.optional() }),
  z.object({ kind: z.literal("trial_ending"), endsOn: z.string().optional() }),
  z.object({ kind: z.literal("usage_alert"), channel: z.enum(["whatsapp", "sms"]), threshold: z.union([z.literal(80), z.literal(100)]), used: z.number().int(), included: z.number().int() }),
]);

async function ownerAddress(tenantDb: TenantDb, tenantId: string): Promise<{ email: string; name: string } | null> {
  const [row] = await tenantDb<{ email: string | null; name: string }[]>`select email, name from tenants where id = ${tenantId}`;
  const email = row?.email?.trim();
  return row && email ? { email, name: row.name } : null;
}

/**
 * Sends one owner email about billing: payment failed, plan started, trial ending, usage alert. The outbox row's
 * dedupe key becomes the notification's semantic key, so a retry never sends it twice. Held as JSON in the message
 * body for the email adapter to render (src/worker/billing-email.ts); it holds plan names and counts only.
 */
export function billingEmailHandler({ sink, now }: Pick<HandlerDependencies, "sink" | "now">): EventHandler {
  return async (tenantDb, event) => {
    const payload = emailPayload.safeParse(event.payload);
    if (!payload.success) return { outcome: "dead", code: "invalid_payload" };
    const owner = await ownerAddress(tenantDb, event.tenantId);
    if (!owner) return { outcome: "dead", code: "no_destination" };
    const at = now();
    const { subscription, entitlements } = await loadBilling(postgresRunner(tenantDb), event.tenantId, { now: at });
    // A failure email names the day full service ends; the grace period runs from the first failure.
    const graceEnds = subscription.pastDueSince ? new Date(subscription.pastDueSince.getTime() + pastDueGraceDays * 86_400_000) : null;
    const body = JSON.stringify({
      ...payload.data,
      planName: entitlements.planName,
      graceEndsOn: graceEnds ? graceEnds.toISOString().slice(0, 10) : null,
      trialEndsOn: subscription.trialEndsAt ? subscription.trialEndsAt.toISOString().slice(0, 10) : null,
      billingUrl: `${appOrigin()}/dashboard`,
    });
    return deliveryToHandlerOutcome(await sink.deliver(tenantDb, {
      tenantId: event.tenantId,
      appointmentId: null,
      patientId: "",
      channel: "email",
      message: { semanticKey: `local:billing:${event.dedupeKey}`, templateKey: `billing.${payload.data.kind}`, body, scheduledAt: at },
      recipient: owner,
    }, at));
  };
}

const providerPayload = z.object({ action: z.enum(["downgrade", "cancel", "resume"]), planKey: planKeySchema.optional() });

/**
 * Tells the provider about a change the owner already made on screen: schedule a downgrade for the renewal, stop
 * renewing at the period end, or undo that. Done here, not in the request, so no provider call waits on a customer.
 * A provider that fails goes round again on the worker's retry schedule and then to dead letter, where staff see it.
 */
export function billingProviderChangeHandler(): EventHandler {
  return async (tenantDb, event) => {
    const payload = providerPayload.safeParse(event.payload);
    if (!payload.success) return { outcome: "dead", code: "invalid_payload" };
    const { subscription } = await loadBilling(postgresRunner(tenantDb), event.tenantId);
    if (!subscription.provider || !subscription.providerSubscriptionId) return "delivered";
    const provider = getSubscriptionProvider(subscription.provider);
    try {
      if (payload.data.action === "cancel") await provider.cancelAtPeriodEnd(subscription.providerSubscriptionId);
      else if (payload.data.action === "resume") await provider.resume(subscription.providerSubscriptionId);
      else if (payload.data.planKey && payload.data.planKey !== "free") {
        const ids = await providerPlanIds(postgresRunner(tenantDb), subscription.provider);
        const providerPlanId = ids[payload.data.planKey];
        if (!providerPlanId) return { outcome: "dead", code: "provider_plan_missing" };
        await provider.changePlan({ providerSubscriptionId: subscription.providerSubscriptionId, providerPlanId, when: "cycle_end", tenantId: event.tenantId, planKey: payload.data.planKey });
      }
    } catch (error) {
      if (error instanceof ProviderNotConfiguredError) return { outcome: "dead", code: "provider_not_configured" };
      return { outcome: "retry", code: "provider_error" };
    }
    return "delivered";
  };
}
