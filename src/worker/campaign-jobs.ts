import type postgres from "postgres";

import { attributeBookings } from "../server/campaigns/attribution";
import { finishCompletedCampaigns, pauseUnhealthyCampaigns } from "../server/campaigns/health";
import { handOffDueSends, queueDueFanouts } from "../server/campaigns/send";
import { postgresRunner } from "../server/workflows/runner";

/**
 * The minute job for campaigns (feature 28). It sends nothing itself: it queues the fan-out for campaigns that are due,
 * hands due messages to the outbox at a steady rate (or holds them for quiet hours), credits bookings made from a
 * message, pauses a campaign whose rates went wrong and finishes one that has gone out. The worker's handlers do the sending.
 */
export interface CampaignSweepSummary {
  tenants: number;
  fanouts: number;
  queued: number;
  held: number;
  credited: number;
  paused: number;
  completed: number;
}

export async function sweepTenantCampaigns(tenantDb: postgres.TransactionSql, tenantId: string, now: Date): Promise<Omit<CampaignSweepSummary, "tenants">> {
  const run = postgresRunner(tenantDb);
  const fanouts = await queueDueFanouts(run, tenantId, now);
  const { queued, held } = await handOffDueSends(run, tenantId, now);
  const credited = await attributeBookings(run, tenantId, now);
  const paused = await pauseUnhealthyCampaigns(run, tenantId);
  const completed = await finishCompletedCampaigns(run, tenantId, now);
  return { fanouts, queued, held, credited, paused, completed };
}

export async function sweepCampaigns(database: postgres.Sql, now: () => Date = () => new Date()): Promise<CampaignSweepSummary> {
  const tenants = await database<{ tenant_id: string }[]>`select tenant_id from kalendr_campaign_tenants('campaign_tick') as tenant_id`;
  const summary: CampaignSweepSummary = { tenants: tenants.length, fanouts: 0, queued: 0, held: 0, credited: 0, paused: 0, completed: 0 };
  for (const { tenant_id: tenantId } of tenants) {
    const result = await database.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      return sweepTenantCampaigns(tenantDb, tenantId, now());
    }) as Omit<CampaignSweepSummary, "tenants">;
    summary.fanouts += result.fanouts;
    summary.queued += result.queued;
    summary.held += result.held;
    summary.credited += result.credited;
    summary.paused += result.paused;
    summary.completed += result.completed;
  }
  return summary;
}
