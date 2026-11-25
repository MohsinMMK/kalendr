import type postgres from "postgres";

import { pastDueGraceDays } from "../lib/entitlements";
import { loadBilling } from "../server/billing/entitlement-loader";
import { queueBillingEmail, writeSubscriptionPatch } from "../server/billing/worker-apply";
import { postgresRunner } from "../server/workflows/runner";

const DAY_MS = 86_400_000;
const TRIAL_REMINDER_DAYS = 3;

export interface BillingSweepSummary extends Record<string, number> {
  tenants: number;
  trialsEnded: number;
  graceEnded: number;
  periodEndsApplied: number;
  trialEmails: number;
}

/**
 * Tidies stored subscription status and sends the trial-ending email (feature 14). A business's effective plan
 * already follows the rules without this job (`effectivePlanKey` reads the dates), so the sweep never decides what a
 * business can do. It only makes the stored status match, applies downgrades and cancellations whose period has
 * ended, and sends mail. Safe to run any number of times: each step moves a row out of the state that selects it.
 */
export async function sweepBilling(database: postgres.Sql, now: Date = new Date()): Promise<BillingSweepSummary> {
  const summary: BillingSweepSummary = { tenants: 0, trialsEnded: 0, graceEnded: 0, periodEndsApplied: 0, trialEmails: 0 };
  const ids = await database<{ tenant_id: string }[]>`select tenant_id from kalendr_billing_tenants() as tenant_id`;
  for (const { tenant_id: tenantId } of ids) {
    summary.tenants += 1;
    await database.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      const { subscription: current } = await loadBilling(postgresRunner(tenantDb), tenantId, { lock: true, now });

      if (current.status === "trialing" && current.trialEndsAt) {
        if (current.trialEndsAt <= now) {
          await writeSubscriptionPatch(tenantDb, tenantId, { status: "free", planKey: "free" });
          summary.trialsEnded += 1;
        } else if (current.trialEndsAt.getTime() - now.getTime() <= TRIAL_REMINDER_DAYS * DAY_MS) {
          // Keyed on the trial's end, so a trial an operator extends sends its reminder again.
          await queueBillingEmail(tenantDb, tenantId, "trial_ending", current.trialEndsAt.toISOString().slice(0, 10), { endsOn: current.trialEndsAt.toISOString().slice(0, 10) });
          summary.trialEmails += 1;
        }
        return;
      }
      if (current.status === "past_due" && current.pastDueSince && now.getTime() - current.pastDueSince.getTime() >= pastDueGraceDays * DAY_MS) {
        await writeSubscriptionPatch(tenantDb, tenantId, { status: "free", planKey: "free", pendingPlanKey: null, cancelAtPeriodEnd: false });
        summary.graceEnded += 1;
        return;
      }
      const periodOver = current.currentPeriodEnd !== null && current.currentPeriodEnd <= now;
      if (!periodOver) return;
      if (current.cancelAtPeriodEnd || current.status === "cancelled") {
        await writeSubscriptionPatch(tenantDb, tenantId, { status: "free", planKey: "free", cancelAtPeriodEnd: false, pendingPlanKey: null });
        summary.periodEndsApplied += 1;
      } else if (current.status === "active" && current.pendingPlanKey) {
        await writeSubscriptionPatch(tenantDb, tenantId, { planKey: current.pendingPlanKey, pendingPlanKey: null });
        summary.periodEndsApplied += 1;
      }
    });
  }
  return summary;
}
