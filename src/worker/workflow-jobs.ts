import { sql } from "drizzle-orm";
import type postgres from "postgres";

import { loadQuietHours, replanTenant } from "../server/workflows/engine";
import { afterQuietHours, isQuietMinute, localMinuteOfDay } from "../server/workflows/quiet-hours";
import { asString, postgresRunner } from "../server/workflows/runner";

/**
 * The two timed jobs that keep message workflows moving. Neither sends anything: the sweep hands due
 * messages to the outbox, and the worker's workflow handler sends them. Each finds its businesses through
 * one definer function that returns ids only, then works inside that business's own row-level scope.
 */

/** Messages claimed per business per run. A bigger backlog is picked up on the next minute. */
const SWEEP_BATCH = 200;

/** Messages that answer something the customer just did are not held for quiet hours. Kept in step with triggers.ts. */
const QUIET_EXEMPT = ["booked", "requested", "rescheduled", "cancelled"];

export interface WorkflowSweepSummary {
  tenants: number;
  queued: number;
  held: number;
}

async function tenantsFor(database: postgres.Sql, job: "workflow_sweep" | "workflow_reconcile"): Promise<string[]> {
  const rows = await database<{ tenant_id: string }[]>`select tenant_id from kalendr_workflow_tenants(${job}) as tenant_id`;
  return rows.map((row) => row.tenant_id);
}

/** Hands every due message in one business to the outbox, or holds it until quiet hours end. Returns what it did. */
export async function sweepTenantMessages(
  tenantDb: postgres.TransactionSql,
  tenantId: string,
  now: Date,
): Promise<{ queued: number; held: number }> {
  const run = postgresRunner(tenantDb);
  const quiet = await loadQuietHours(run, tenantId);
  const due = await run(sql`
    select message.id, message.appointment_id, step.ignore_quiet_hours, workflow.trigger,
      coalesce(location.timezone, tenant.timezone) as time_zone
    from scheduled_messages as message
    join workflow_steps as step on step.tenant_id = message.tenant_id and step.id = message.step_id
    join workflows as workflow on workflow.tenant_id = step.tenant_id and workflow.id = step.workflow_id
    join appointments as appointment on appointment.tenant_id = message.tenant_id and appointment.id = message.appointment_id
    join locations as location on location.tenant_id = appointment.tenant_id and location.id = appointment.location_id
    join tenants as tenant on tenant.id = message.tenant_id
    where message.tenant_id = ${tenantId} and message.status = 'pending' and message.send_at <= ${now.toISOString()}::timestamptz
    order by message.send_at
    limit ${SWEEP_BATCH}
    for update of message skip locked
  `);
  let queued = 0;
  let held = 0;
  for (const row of due) {
    const timeZone = asString(row.time_zone) || "UTC";
    const exempt = Boolean(row.ignore_quiet_hours) || QUIET_EXEMPT.includes(asString(row.trigger));
    if (!exempt && isQuietMinute(localMinuteOfDay(now, timeZone), quiet.startMinute, quiet.endMinute)) {
      const until = afterQuietHours(now, timeZone, quiet.startMinute, quiet.endMinute);
      await run(sql`update scheduled_messages set send_at = ${until.toISOString()}::timestamptz, updated_at = now() where tenant_id = ${tenantId} and id = ${asString(row.id)}`);
      held += 1;
      continue;
    }
    await run(sql`update scheduled_messages set status = 'queued', updated_at = now() where tenant_id = ${tenantId} and id = ${asString(row.id)}`);
    await run(sql`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
      values (${tenantId}, 'appointment', ${asString(row.appointment_id)}, 'workflow.message',
        jsonb_build_object('scheduledMessageId', ${asString(row.id)}::text), ${`workflow.message:${asString(row.id)}`})
      on conflict (tenant_id, dedupe_key) do nothing
    `);
    queued += 1;
  }
  return { queued, held };
}

export async function sweepWorkflowMessages(database: postgres.Sql, now: () => Date = () => new Date()): Promise<WorkflowSweepSummary> {
  const tenantIds = await tenantsFor(database, "workflow_sweep");
  const summary = { tenants: tenantIds.length, queued: 0, held: 0 };
  for (const tenantId of tenantIds) {
    const result = await database.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      return sweepTenantMessages(tenantDb, tenantId, now());
    }) as { queued: number; held: number };
    summary.queued += result.queued;
    summary.held += result.held;
  }
  return summary;
}

/** After an owner edits workflows (or the standard set is first switched on), re-plan every upcoming booking once. */
export async function reconcileWorkflows(database: postgres.Sql, now: () => Date = () => new Date()): Promise<{ tenants: number; appointments: number }> {
  const tenantIds = await tenantsFor(database, "workflow_reconcile");
  let appointments = 0;
  for (const tenantId of tenantIds) {
    appointments += await database.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      const startedAt = now();
      const count = await replanTenant(postgresRunner(tenantDb), tenantId, startedAt);
      // An edit made after this pass began has a later updated_at, so it keeps the flag cleared and runs again.
      await tenantDb`
        update workflow_settings set reconciled_at = now()
        where tenant_id = ${tenantId} and reconciled_at is null and updated_at <= now()
      `;
      return count;
    }) as number;
  }
  return { tenants: tenantIds.length, appointments };
}
