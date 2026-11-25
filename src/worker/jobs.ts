import type postgres from "postgres";

import { sweepOffers } from "../server/waitlist-offers";
import { postgresRunner } from "../server/workflows/runner";
import { applyTenantRetention, deleteExpiredLoginCodes, queueOverdueAlerts, totalRetention } from "../server/privacy/retention";

/**
 * The timed jobs pg-boss runs. Each one only writes outbox rows or updates state: none sends
 * anything itself. The worker finds which businesses have work through one definer function
 * that returns ids only, then does the work inside each business's own row-level scope.
 */

const REMINDER_LEAD_MS = 24 * 60 * 60 * 1_000;
/** Delivered hand-off rows are kept this long for support, then removed. Dead letters are kept. */
const DELIVERED_OUTBOX_RETENTION_DAYS = 30;

export type TenantJob = "reminder_sweep" | "hold_expiry" | "retention" | "dead_letter_report" | "request_expiry" | "reschedule_expiry" | "waitlist_sweep" | "staff_digest" | "owner_summary";

export interface JobSummary {
  tenants: number;
  rows: number;
}

async function tenantsFor(database: postgres.Sql, job: TenantJob): Promise<string[]> {
  if (job === "owner_summary") {
    const due = await database<{ tenant_id: string }[]>`select kalendr_owner_summary_tenants() as tenant_id`;
    return due.map((row) => row.tenant_id);
  }
  if (job === "staff_digest") {
    const due = await database<{ tenant_id: string }[]>`select kalendr_staff_digest_tenants() as tenant_id`;
    return due.map((row) => row.tenant_id);
  }
  const rows = await database<{ tenant_id: string }[]>`select tenant_id from kalendr_worker_tenants(${job}) as tenant_id`;
  return rows.map((row) => row.tenant_id);
}

export async function forEachTenant(
  database: postgres.Sql,
  job: TenantJob,
  work: (tenantDb: postgres.TransactionSql, tenantId: string) => Promise<number>,
): Promise<JobSummary> {
  const tenantIds = await tenantsFor(database, job);
  let rows = 0;
  for (const tenantId of tenantIds) {
    rows += await database.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      return work(tenantDb, tenantId);
    }) as number;
  }
  return { tenants: tenantIds.length, rows };
}

/**
 * Queues a reminder for each active appointment starting in the next 24 hours. The key holds
 * the appointment's version, so a moved appointment gets a fresh reminder and the old one is
 * dropped by its handler. Running it twice queues nothing new. A business on message workflows
 * (feature 5) is skipped: its reminders come from its workflows instead.
 */
export function sweepReminders(database: postgres.Sql): Promise<JobSummary> {
  return forEachTenant(database, "reminder_sweep", async (tenantDb, tenantId) => {
    const inserted = await tenantDb`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
      select appointment.tenant_id, 'appointment', appointment.id, 'appointment.reminder',
        jsonb_build_object('appointmentId', appointment.id, 'version', appointment.version),
        'appointment.reminder:' || appointment.id || ':' || appointment.version
      from appointments as appointment
      where appointment.tenant_id = ${tenantId}
        and appointment.reminder_status = 'queued'
        and not appointment.is_sample
        and not exists (
          select 1 from workflow_settings as settings
          where settings.tenant_id = appointment.tenant_id and settings.presets_applied_at is not null
        )
        and appointment.status in ('requested', 'booked')
        and appointment.starts_at > now()
        and appointment.starts_at <= now() + ${REMINDER_LEAD_MS} * interval '1 millisecond'
      on conflict (tenant_id, dedupe_key) do nothing
      returning id
    `;
    return inserted.length;
  });
}

/** Frees slots a booking held but never confirmed, so they show as open again. */
export function expireSlotHolds(database: postgres.Sql): Promise<JobSummary> {
  return forEachTenant(database, "hold_expiry", async (tenantDb, tenantId) => {
    const released = await tenantDb`
      update resource_reservations
      set state = 'released', updated_at = now()
      where tenant_id = ${tenantId} and state = 'held' and hold_expires_at <= now()
      returning id
    `;
    // Short holds taken while a customer fills in the booking form (feature 39). The engine ignores them once past
    // their expiry, so this is only tidying.
    const expired = await tenantDb`delete from slot_holds where tenant_id = ${tenantId} and expires_at <= now() returning id`;
    return released.length + expired.length;
  });
}

/**
 * The safety net behind the waitlist's timed events (feature 21): an offer past its answer time is ended and passed to the
 * next person, and an offer whose message never went out is queued again. The events do this on time; this catches a worker
 * that was down.
 */
export function sweepWaitlist(database: postgres.Sql): Promise<JobSummary> {
  return forEachTenant(database, "waitlist_sweep", async (tenantDb, tenantId) => {
    const result = await sweepOffers(postgresRunner(tenantDb), tenantId, new Date());
    return result.expired + result.requeued;
  });
}

/** Removes expired idempotency keys and old delivered hand-off rows. Nothing a customer or staff member wrote. */
export function applyRetention(database: postgres.Sql): Promise<JobSummary> {
  return forEachTenant(database, "retention", async (tenantDb, tenantId) => {
    const keys = await tenantDb`
      delete from idempotency_keys where tenant_id = ${tenantId} and expires_at < now() returning id
    `;
    const events = await tenantDb`
      delete from outbox_events
      where tenant_id = ${tenantId} and status = 'delivered'
        and updated_at < now() - ${DELIVERED_OUTBOX_RETENTION_DAYS} * interval '1 day'
      returning id
    `;
    // Chats with the booking assistant (feature 30) are kept for the number of days the owner chose, 90 unless set.
    const chats = await tenantDb`
      delete from assistant_conversations
      where tenant_id = ${tenantId}
        and last_activity_at < now() - coalesce((select retention_days from assistant_settings where tenant_id = ${tenantId}), 90) * interval '1 day'
      returning id
    `;
    return keys.length + events.length + chats.length;
  });
}

export interface OutboxHealth {
  pending: number;
  oldestPendingSeconds: number;
  deadLetters: number;
  tenantsWithDeadLetters: number;
}

/** Counts only, across every business: no ids, names or content. */
export async function outboxHealth(database: postgres.Sql): Promise<OutboxHealth> {
  const [row] = await database<{
    pending: number;
    oldest_pending_seconds: number;
    dead_letters: number;
    tenants_with_dead_letters: number;
  }[]>`select * from kalendr_outbox_health()`;
  return {
    pending: Number(row?.pending ?? 0),
    oldestPendingSeconds: Number(row?.oldest_pending_seconds ?? 0),
    deadLetters: Number(row?.dead_letters ?? 0),
    tenantsWithDeadLetters: Number(row?.tenants_with_dead_letters ?? 0),
  };
}

/** The hourly dead-letter count that alerting reads. Staff see the rows themselves on the Messages screen. */
export function reportDeadLetters(database: postgres.Sql): Promise<OutboxHealth> {
  return outboxHealth(database);
}

/**
 * Nightly privacy clean-up (feature 7). Each business's own retention settings decide what goes; sign-in codes belong
 * to no business and go once per run. Returns counts only, and writes one audit row per business that had something removed.
 */
export async function applyPrivacyRetention(database: postgres.Sql): Promise<JobSummary & { loginCodes: number; loginSessions: number }> {
  const login = await deleteExpiredLoginCodes(database);
  const summary = await forEachTenant(database, "retention", async (tenantDb, tenantId) => totalRetention(await applyTenantRetention(tenantDb, tenantId)));
  return { ...summary, loginCodes: login.codes, loginSessions: login.sessions };
}

/** Daily: one outbox email to the business for each customer privacy request that is past its due date. Once per request. */
export function alertOverduePrivacyRequests(database: postgres.Sql): Promise<JobSummary> {
  return forEachTenant(database, "retention", (tenantDb, tenantId) => queueOverdueAlerts(tenantDb, tenantId));
}
