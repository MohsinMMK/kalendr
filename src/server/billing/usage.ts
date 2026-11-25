/**
 * Message metering (feature 14): one counter per month, channel and cost category, written by the worker at the
 * moment a message is sent. No "server-only": the worker imports this.
 *
 * Metrics are `message:<channel>` (the total the meter and the alerts read), `message:<channel>:<category>`, and
 * `message:sms:segments`. The period is the first day of the UTC month, so a new month starts at zero with no reset job.
 */
import type postgres from "postgres";

import { usageAlertMarker, usageAlertsDue, usagePeriod, type UsageThreshold } from "../../lib/billing-rules";
import type { PlanLimits } from "../../lib/entitlements";

type TenantDb = postgres.TransactionSql;

export type MeteredChannel = "email" | "whatsapp" | "sms";

async function bump(tenantDb: TenantDb, tenantId: string, period: string, metric: string, by: number): Promise<number> {
  const [row] = await tenantDb<{ count: number }[]>`
    insert into usage_counters (tenant_id, period, metric, count) values (${tenantId}, ${period}::date, ${metric}, ${by})
    on conflict (tenant_id, period, metric) do update set count = usage_counters.count + ${by}, updated_at = now()
    returning count
  `;
  return Number(row?.count ?? 0);
}

/**
 * Counts one sent message. Called only on the transition to sent (the delivery path returns "duplicate" for a repeat
 * and never reaches this), so a retry or a duplicate delivery cannot count twice. Returns the channel's new total.
 */
export async function recordMessageUsage(tenantDb: TenantDb, tenantId: string, channel: MeteredChannel, costCategory: string | null, segments: number | null, now: Date = new Date()): Promise<number> {
  const period = usagePeriod(now);
  const total = await bump(tenantDb, tenantId, period, `message:${channel}`, 1);
  const category = (costCategory ?? "utility").replace(/[^a-z_]/g, "").slice(0, 20) || "utility";
  await bump(tenantDb, tenantId, period, `message:${channel}:${category}`, 1);
  if (channel === "sms" && segments && segments > 0) await bump(tenantDb, tenantId, period, "message:sms:segments", segments);
  return total;
}

export async function messagesUsedThisMonth(tenantDb: TenantDb, tenantId: string, channel: MeteredChannel, now: Date = new Date()): Promise<number> {
  const [row] = await tenantDb<{ count: number }[]>`
    select count from usage_counters where tenant_id = ${tenantId} and period = ${usagePeriod(now)}::date and metric = ${`message:${channel}`}
  `;
  return Number(row?.count ?? 0);
}

/**
 * Queues the 80% and 100% emails once each per month: the marker (`whatsapp:80:2026-11`) is stored on the
 * subscription in the same statement that claims it, so two senders cannot both announce the same threshold.
 */
export async function queueUsageAlerts(tenantDb: TenantDb, tenantId: string, channel: "whatsapp" | "sms", used: number, limits: Pick<PlanLimits, "messagesIncluded">, now: Date = new Date()): Promise<UsageThreshold[]> {
  const included = limits.messagesIncluded[channel];
  const [row] = await tenantDb<{ usage_alerts_sent: string[] }[]>`select usage_alerts_sent from tenant_subscriptions where tenant_id = ${tenantId}`;
  const due = usageAlertsDue({ channel, used, included, sent: row?.usage_alerts_sent ?? [], now });
  for (const threshold of due) {
    const marker = usageAlertMarker(channel, threshold, now);
    const claimed = await tenantDb`
      update tenant_subscriptions set usage_alerts_sent = array_append(usage_alerts_sent, ${marker}), updated_at = now()
      where tenant_id = ${tenantId} and not (${marker} = any(usage_alerts_sent)) returning id
    `;
    if (claimed.length === 0) continue;
    await tenantDb`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
      values (${tenantId}, 'billing', ${tenantId}, 'billing.email',
        ${tenantDb.json({ kind: "usage_alert", channel, threshold, used, included })}, ${`billing.email:usage:${marker}`})
      on conflict (tenant_id, dedupe_key) do nothing
    `;
  }
  return due;
}
