/**
 * Campaign fan-out and hand-off (feature 28). Both run in the worker, inside one business's row-level scope.
 *
 * Fan-out writes one `campaign_sends` row per customer, spread over time at a steady rate. The unique key (campaign,
 * customer, cycle) is the whole safety story: a restart finds the rows and adds nothing, so nothing is chosen twice.
 * Hand-off then moves due rows to the outbox one at a time with `skip locked`, and the send handler decides, one
 * customer at a time, whether to actually send. Nothing here calls a provider.
 *
 * No "server-only": the worker uses this file.
 */
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { bookingLinkPath } from "../../lib/booking-links";
import { CAMPAIGN_FANOUT_EVENT, CAMPAIGN_SEND_EVENT, SENDS_PER_MINUTE, campaignRuleSchema, type CampaignChannel, type CampaignKind } from "../../lib/campaign-contracts";
import { segmentFilterSchema } from "../../lib/segment-filter";
import { afterQuietHours, isQuietMinute, localMinuteOfDay } from "../workflows/quiet-hours";
import { loadQuietHours } from "../workflows/engine";
import { asDate, asNumber, asString, type Runner } from "../workflows/runner";
import { localDay, loadAudience, type AudienceCampaign } from "./audience";
import { newUnsubscribeToken } from "./tokens";

export interface CampaignRow extends AudienceCampaign {
  name: string;
  status: string;
  version: number;
  subject: string;
  body: string;
  templateKey: string | null;
  code: string;
  scheduledAt: Date | null;
  lastRunOn: string | null;
  pausedReason: string | null;
}

/** One campaign as the worker reads it. The stored rule and filter are parsed again, so a row edited by hand cannot widen an audience. */
export async function loadCampaign(run: Runner, tenantId: string, campaignId: string, lock = false): Promise<CampaignRow | null> {
  const [row] = await run(sql`select * from campaigns where tenant_id = ${tenantId} and id = ${campaignId} ${lock ? sql`for update` : sql``}`);
  if (!row) return null;
  const rule = row.rule_type ? campaignRuleSchema.safeParse({ type: row.rule_type, ...(row.rule as Record<string, unknown>) }) : null;
  const filter = row.segment_filter ? segmentFilterSchema.safeParse(row.segment_filter) : null;
  const kind: CampaignKind = row.kind === "automated" ? "automated" : "one_off";
  const channel: CampaignChannel = row.channel === "whatsapp" ? "whatsapp" : row.channel === "sms" ? "sms" : "email";
  return {
    id: asString(row.id),
    kind,
    channel,
    // A rule or filter that no longer parses leaves the audience empty rather than open.
    rule: rule?.success ? rule.data : null,
    segmentFilter: filter?.success ? filter.data : kind === "one_off" ? { all: [{ field: "visits", op: "lt", value: 0 }] } : null,
    serviceId: row.service_id ? asString(row.service_id) : null,
    name: asString(row.name),
    status: asString(row.status),
    version: asNumber(row.version),
    subject: asString(row.subject),
    body: asString(row.body),
    templateKey: row.template_key ? asString(row.template_key) : null,
    code: asString(row.code),
    scheduledAt: row.scheduled_at ? asDate(row.scheduled_at) : null,
    lastRunOn: row.last_run_on ? asString(row.last_run_on).slice(0, 10) : null,
    pausedReason: row.paused_reason ? asString(row.paused_reason) : null,
  };
}

/**
 * The service a campaign's {service} stands for. A campaign about one service names it. A recall names the service
 * this customer last came in for among the ones it covers, or its first service when there is no customer (preview, test).
 */
export async function campaignServiceName(run: Runner, tenantId: string, campaign: Pick<CampaignRow, "serviceId" | "rule">, patientId?: string): Promise<string | null> {
  if (campaign.serviceId) {
    const [row] = await run(sql`select name from services where tenant_id = ${tenantId} and id = ${campaign.serviceId}`);
    return row?.name ? asString(row.name) : null;
  }
  if (campaign.rule?.type !== "recall" || !campaign.rule.services.length) return null;
  const ids = sql.join(campaign.rule.services.map((entry) => sql`${entry.serviceId}`), sql`, `);
  if (patientId) {
    const [row] = await run(sql`
      select service.name from appointments as visit join services as service on service.tenant_id = visit.tenant_id and service.id = visit.service_id
      where visit.tenant_id = ${tenantId} and visit.patient_id = ${patientId} and visit.status = 'completed' and not visit.is_test and not visit.is_sample
        and visit.service_id in (${ids})
      order by visit.starts_at desc limit 1
    `);
    if (row?.name) return asString(row.name);
  }
  const [row] = await run(sql`select name from services where tenant_id = ${tenantId} and id = ${campaign.rule.services[0].serviceId}`);
  return row?.name ? asString(row.name) : null;
}

export async function tenantFacts(run: Runner, tenantId: string): Promise<{ timeZone: string; slug: string; name: string; phone: string | null }> {
  const [row] = await run(sql`select timezone, slug, name, phone from tenants where id = ${tenantId}`);
  return { timeZone: asString(row?.timezone) || "UTC", slug: asString(row?.slug), name: asString(row?.name), phone: row?.phone ? asString(row.phone) : null };
}

/** The booking page with the campaign's code, so a booking made from the message can be credited to it. */
export function campaignBookingPath(slug: string, code: string, channel: CampaignChannel): string {
  return bookingLinkPath(slug, { serviceSlug: null, utmSource: "kalendr", utmMedium: channel, utmCampaign: code, prefill: {} });
}

export interface FanoutResult {
  matching: number;
  created: number;
}

/**
 * Writes the sends for one run of a campaign. Safe to run twice: the second run creates nothing.
 * A one-off campaign becomes "sending" (or "completed" at once when nobody qualifies); an automated one stays on.
 */
export async function fanoutCampaign(run: Runner, tenantId: string, campaignId: string, now: Date): Promise<FanoutResult> {
  const campaign = await loadCampaign(run, tenantId, campaignId, true);
  if (!campaign || (campaign.status !== "active" && campaign.status !== "sending")) return { matching: 0, created: 0 };
  const facts = await tenantFacts(run, tenantId);
  const audience = await loadAudience(run, campaign, { tenantId, now, timeZone: facts.timeZone });
  const rate = SENDS_PER_MINUTE[campaign.channel];
  const start = campaign.kind === "one_off" && campaign.scheduledAt && campaign.scheduledAt > now ? campaign.scheduledAt : now;
  let created = 0;
  const batch = 200;
  for (let offset = 0; offset < audience.eligible.length; offset += batch) {
    const slice = audience.eligible.slice(offset, offset + batch);
    const values = slice.map((member, index) => {
      const id = randomUUID();
      const token = newUnsubscribeToken(tenantId, id);
      const sendAt = new Date(start.getTime() + Math.floor((offset + index) / rate) * 60_000);
      return sql`(${id}, ${tenantId}, ${campaignId}, ${member.patientId}, ${member.cycle}, ${campaign.channel}, ${sendAt.toISOString()}::timestamptz, ${token.hash}, ${token.ciphertext})`;
    });
    const inserted = await run(sql`
      insert into campaign_sends (id, tenant_id, campaign_id, patient_id, cycle, channel, send_at, unsubscribe_token_hash, unsubscribe_token_ciphertext)
      values ${sql.join(values, sql`, `)}
      on conflict (tenant_id, campaign_id, patient_id, cycle) do nothing
      returning id
    `);
    created += inserted.length;
  }
  if (campaign.kind === "one_off") {
    await run(sql`
      update campaigns set status = ${created === 0 ? "completed" : "sending"}, started_at = coalesce(started_at, ${now.toISOString()}::timestamptz),
        completed_at = ${created === 0 ? now.toISOString() : null}::timestamptz, updated_at = now()
      where tenant_id = ${tenantId} and id = ${campaignId}
    `);
  } else {
    await run(sql`update campaigns set last_run_on = ${localDay(now, facts.timeZone)}::date, started_at = coalesce(started_at, ${now.toISOString()}::timestamptz), updated_at = now() where tenant_id = ${tenantId} and id = ${campaignId}`);
  }
  return { matching: audience.matching, created };
}

/** Puts a fan-out for each campaign that is due on the outbox, once per run (a day for automated ones). */
export async function queueDueFanouts(run: Runner, tenantId: string, now: Date): Promise<number> {
  const { timeZone } = await tenantFacts(run, tenantId);
  const today = localDay(now, timeZone);
  const due = await run(sql`
    select id, kind from campaigns
    where tenant_id = ${tenantId} and status = 'active'
      and ((kind = 'automated' and (last_run_on is null or last_run_on <> ${today}::date))
        or (kind = 'one_off' and (scheduled_at is null or scheduled_at <= ${now.toISOString()}::timestamptz)))
  `);
  let queued = 0;
  for (const row of due) {
    const runKey = row.kind === "automated" ? today : "once";
    const inserted = await run(sql`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
      values (${tenantId}, 'campaign', ${asString(row.id)}, ${CAMPAIGN_FANOUT_EVENT}, jsonb_build_object('campaignId', ${asString(row.id)}::text), ${`${CAMPAIGN_FANOUT_EVENT}:${asString(row.id)}:${runKey}`})
      on conflict (tenant_id, dedupe_key) do nothing returning id
    `);
    queued += inserted.length;
  }
  return queued;
}

/** Messages handed to the worker per business per minute. A longer list is picked up on the next minute. */
export const HAND_OFF_BATCH = 200;

/**
 * Moves due sends to the outbox, or holds them until quiet hours end. A campaign that is paused, finished or cancelled
 * hands nothing on: its waiting rows stay waiting, so turning it back on carries on where it stopped.
 */
export async function handOffDueSends(run: Runner, tenantId: string, now: Date): Promise<{ queued: number; held: number }> {
  const [quiet, facts] = await Promise.all([loadQuietHours(run, tenantId), tenantFacts(run, tenantId)]);
  if (isQuietMinute(localMinuteOfDay(now, facts.timeZone), quiet.startMinute, quiet.endMinute)) {
    const until = afterQuietHours(now, facts.timeZone, quiet.startMinute, quiet.endMinute);
    const held = await run(sql`
      update campaign_sends as send set send_at = ${until.toISOString()}::timestamptz, updated_at = now()
      from campaigns as campaign
      where send.tenant_id = ${tenantId} and send.status = 'pending' and send.send_at <= ${now.toISOString()}::timestamptz
        and campaign.tenant_id = send.tenant_id and campaign.id = send.campaign_id and campaign.status in ('active', 'sending')
      returning send.id
    `);
    return { queued: 0, held: held.length };
  }
  const due = await run(sql`
    select send.id, send.campaign_id from campaign_sends as send
    join campaigns as campaign on campaign.tenant_id = send.tenant_id and campaign.id = send.campaign_id
    where send.tenant_id = ${tenantId} and send.status = 'pending' and send.send_at <= ${now.toISOString()}::timestamptz and campaign.status in ('active', 'sending')
    order by send.send_at, send.id limit ${HAND_OFF_BATCH}
    for update of send skip locked
  `);
  for (const row of due) {
    await run(sql`update campaign_sends set status = 'queued', updated_at = now() where tenant_id = ${tenantId} and id = ${asString(row.id)}`);
    await run(sql`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
      values (${tenantId}, 'campaign', ${asString(row.campaign_id)}, ${CAMPAIGN_SEND_EVENT}, jsonb_build_object('sendId', ${asString(row.id)}::text), ${`${CAMPAIGN_SEND_EVENT}:${asString(row.id)}`})
      on conflict (tenant_id, dedupe_key) do nothing
    `);
  }
  return { queued: due.length, held: 0 };
}
