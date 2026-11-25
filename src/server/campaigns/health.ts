/**
 * Keeping campaigns honest while they run (feature 28): a campaign with a high failure or unsubscribe rate pauses itself
 * and tells the owner, and a one-off campaign is finished once its last message has gone.
 * No "server-only": the worker's minute job calls it.
 */
import { sql } from "drizzle-orm";

import { judgeCampaignHealth, pausedReasonText } from "../../lib/campaign-contracts";
import { isStaffRole, resolvePermissions } from "../../lib/permissions";
import { asNumber, asString, type Runner } from "../workflows/runner";

export async function finishCompletedCampaigns(run: Runner, tenantId: string, now: Date): Promise<number> {
  const done = await run(sql`
    update campaigns set status = 'completed', completed_at = ${now.toISOString()}::timestamptz, updated_at = now()
    where tenant_id = ${tenantId} and kind = 'one_off' and status = 'sending'
      and not exists (select 1 from campaign_sends as send where send.tenant_id = campaigns.tenant_id and send.campaign_id = campaigns.id and send.status in ('pending', 'queued'))
    returning id
  `);
  return done.length;
}

/** Pauses every running campaign whose rates are past the limits, and puts a notice under the bell for the people who run campaigns. */
export async function pauseUnhealthyCampaigns(run: Runner, tenantId: string): Promise<number> {
  const rows = await run(sql`
    select campaign.id, campaign.name,
      count(*) filter (where send.status = 'sent')::int as sent,
      count(*) filter (where send.status = 'failed')::int as failed,
      count(*) filter (where send.unsubscribed_at is not null)::int as unsubscribed
    from campaigns as campaign join campaign_sends as send on send.tenant_id = campaign.tenant_id and send.campaign_id = campaign.id
    where campaign.tenant_id = ${tenantId} and campaign.status in ('active', 'sending')
    group by campaign.id, campaign.name
  `);
  let paused = 0;
  for (const row of rows) {
    const verdict = judgeCampaignHealth({ sent: asNumber(row.sent), failed: asNumber(row.failed), unsubscribed: asNumber(row.unsubscribed) });
    if (verdict.ok) continue;
    const changed = await run(sql`
      update campaigns set status = 'paused', paused_reason = ${verdict.reason}, updated_at = now(), version = version + 1
      where tenant_id = ${tenantId} and id = ${asString(row.id)} and status in ('active', 'sending') returning id
    `);
    if (changed.length === 0) continue;
    paused += 1;
    await run(sql`
      insert into audit_events (tenant_id, actor_type, action, outcome, metadata)
      values (${tenantId}, 'system', 'campaign.auto_paused', 'success', jsonb_build_object('campaignId', ${asString(row.id)}::text, 'reason', ${verdict.reason}::text))
    `);
    await notifyCampaignManagers(run, tenantId, asString(row.id), `Campaign paused: ${asString(row.name).slice(0, 80)}`, verdict.reason);
  }
  return paused;
}

async function notifyCampaignManagers(run: Runner, tenantId: string, campaignId: string, title: string, reason: keyof typeof pausedReasonText): Promise<void> {
  const members = await run(sql`select id, role, permission_overrides from memberships where tenant_id = ${tenantId} and is_active`);
  for (const member of members) {
    const role = asString(member.role);
    if (!isStaffRole(role) || !resolvePermissions(role, member.permission_overrides).includes("campaigns.manage")) continue;
    await run(sql`
      insert into staff_notifications (tenant_id, membership_id, kind, title, link, dedupe_key)
      values (${tenantId}, ${asString(member.id)}, 'campaign.paused', ${title.slice(0, 140)}, ${`/campaigns?campaign=${campaignId}`}, ${`campaign.paused:${campaignId}:${reason}`})
      on conflict (tenant_id, membership_id, dedupe_key) do nothing
    `);
  }
}
