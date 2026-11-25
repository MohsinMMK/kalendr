import type postgres from "postgres";

import { decideMessageGate } from "../lib/billing-rules";
import { CAMPAIGN_MESSAGE_EVENT } from "../lib/campaign-contracts";
import { channelTemplateFor } from "../lib/channel-templates";
import { loadBilling } from "../server/billing/entitlement-loader";
import { messagesUsedThisMonth, queueUsageAlerts, recordMessageUsage } from "../server/billing/usage";
import { suppressionReason } from "../server/messaging/suppression";
import { postgresRunner } from "../server/workflows/runner";
import type { DeliveryOutcome, MessageSink, OutgoingMessage } from "./delivery";
import type { TenantDb } from "./handlers/types";

/**
 * What a business's plan does to a message at the moment it would be sent (feature 14). One wrapper around the
 * sink, so every handler that sends (reminders, confirmations, workflows, quick messages, review requests) is
 * covered without each one knowing about plans.
 *
 * - Email always goes.
 * - WhatsApp or SMS with no allowance on the plan: marketing-style messages fail at once with `plan_channel_locked`
 *   (dead, never retried, visible under Failed). Confirmations and reminders are NEVER silently stopped: they go by
 *   email when the customer has a usable address, and otherwise are sent anyway and an activity-log entry says so.
 * - Past the monthly allowance, marketing messages stop with `plan_overage_stopped` when the owner chose
 *   stop_marketing, and are sent and counted (billed as overage) when they chose bill_overage.
 */

async function templateCostCategory(tenantDb: TenantDb, channel: "whatsapp" | "sms", templateKey: string): Promise<string | null> {
  // Every campaign message is marketing, whichever approved template carries it (feature 28), and never a protected one.
  if (templateKey === CAMPAIGN_MESSAGE_EVENT) return "marketing";
  const key = channelTemplateFor(templateKey);
  if (!key) return null;
  const rows = await tenantDb<{ cost_category: string }[]>`
    select cost_category from message_templates where channel = ${channel} and key = ${key} order by (language = 'en') desc limit 1
  `;
  return rows[0]?.cost_category ?? null;
}

async function hasUsableEmail(tenantDb: TenantDb, tenantId: string, patientId: string): Promise<boolean> {
  const [row] = await tenantDb<{ email: string | null }[]>`select email from patients where tenant_id = ${tenantId} and id = ${patientId}`;
  const email = row?.email?.trim();
  if (!email) return false;
  return (await suppressionReason(tenantDb, tenantId, "email", email)) === null;
}

async function recordBlocked(tenantDb: TenantDb, outgoing: OutgoingMessage, code: string, now: Date): Promise<void> {
  const semanticKey = outgoing.message.semanticKey.replace(/^local:[a-z]+:/, `${outgoing.channel}:`);
  await tenantDb`
    insert into notifications (
      tenant_id, appointment_id, channel, template_key, destination_ciphertext, semantic_key, status, scheduled_at, failed_at, failure_code, attempt_count
    ) values (
      ${outgoing.tenantId}, ${outgoing.appointmentId}, ${outgoing.channel}, ${outgoing.message.templateKey}, ${`plan:${outgoing.channel}`},
      ${semanticKey}, 'failed', ${outgoing.message.scheduledAt}, ${now}, ${code}, 1
    )
    on conflict (tenant_id, semantic_key) do update set status = 'failed', failed_at = excluded.failed_at, failure_code = excluded.failure_code, updated_at = now()
  `;
}

export function planGatedSink(inner: MessageSink): MessageSink {
  return {
    mode: inner.mode,
    async deliver(tenantDb, outgoing, now): Promise<DeliveryOutcome> {
      // Email is on every plan; a workflow's test message and the owner's own notices are never held back.
      if (outgoing.channel === "email" || outgoing.testRecipientEmail || outgoing.testRecipientPhone || outgoing.recipient) return inner.deliver(tenantDb, outgoing, now);
      const { subscription, entitlements } = await loadBilling(postgresRunner(tenantDb), outgoing.tenantId, { now });
      const included = entitlements.limits.messagesIncluded[outgoing.channel];
      const decision = decideMessageGate({
        channel: outgoing.channel,
        templateKey: outgoing.message.templateKey,
        costCategory: await templateCostCategory(tenantDb, outgoing.channel, outgoing.message.templateKey),
        limits: entitlements.limits,
        used: included > 0 ? await messagesUsedThisMonth(tenantDb, outgoing.tenantId, outgoing.channel, now) : 0,
        overageMode: subscription.overageMode,
        hasUsableEmail: included > 0 ? true : await hasUsableEmail(tenantDb, outgoing.tenantId, outgoing.patientId),
      });
      switch (decision.action) {
        case "send":
          return inner.deliver(tenantDb, outgoing, now);
        case "fallback_email":
          return inner.deliver(tenantDb, { ...outgoing, channel: "email" }, now);
        case "send_anyway":
          // Nothing to fall back to, and a confirmation or reminder must not vanish: send it, and leave a trace.
          await tenantDb`
            insert into audit_events (tenant_id, actor_type, action, outcome, metadata)
            values (${outgoing.tenantId}, 'system', 'billing.protected_message_sent_without_allowance', 'success',
              ${tenantDb.json({ channel: outgoing.channel, templateKey: outgoing.message.templateKey, alert: decision.alert })})
          `;
          return inner.deliver(tenantDb, outgoing, now);
        case "block":
          await recordBlocked(tenantDb, outgoing, decision.code, now);
          return { outcome: "dead", code: decision.code };
      }
    },
  };
}

/**
 * Counts a message that has just been sent and queues the 80% / 100% owner emails. Called by `providerSink` in the
 * same transaction as the notification's move to sent, and only on that move, so a retry or a duplicate cannot count twice.
 */
export async function meterSentMessage(
  tenantDb: postgres.TransactionSql,
  tenantId: string,
  channel: "email" | "whatsapp" | "sms",
  costCategory: string | null,
  segments: number | null,
  now: Date,
): Promise<void> {
  const total = await recordMessageUsage(tenantDb, tenantId, channel, costCategory, segments, now);
  if (channel === "email") return;
  const { entitlements } = await loadBilling(postgresRunner(tenantDb), tenantId, { now });
  await queueUsageAlerts(tenantDb, tenantId, channel, total, entitlements.limits, now);
}
