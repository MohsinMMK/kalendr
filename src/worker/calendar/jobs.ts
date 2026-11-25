/**
 * The timed calendar jobs. Like the other timed jobs they only queue outbox rows (or tidy up); the
 * provider calls happen in the handlers. The definer function `kalendr_calendar_tenants` says which
 * businesses have work, ids only. Queue keys carry a time bucket, so a run twice in a bucket adds nothing.
 */
import type postgres from "postgres";

import { CALENDAR_RENEW_EVENT, CALENDAR_SYNC_EVENT } from "../../lib/calendar-sync";

type CalendarJob = "renew" | "poll" | "resnapshot" | "cleanup";

export interface CalendarJobSummary {
  tenants: number;
  rows: number;
}

async function forEachCalendarTenant(
  database: postgres.Sql,
  job: CalendarJob,
  work: (tenantDb: postgres.TransactionSql, tenantId: string) => Promise<number>,
): Promise<CalendarJobSummary> {
  const tenants = await database<{ tenant_id: string }[]>`select tenant_id from kalendr_calendar_tenants(${job}) as tenant_id`;
  let rows = 0;
  for (const { tenant_id: tenantId } of tenants) {
    rows += await database.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      return work(tenantDb, tenantId);
    }) as number;
  }
  return { tenants: tenants.length, rows };
}

const bucket = (now: Date, minutes: number) => Math.floor(now.getTime() / (minutes * 60_000));

/** Hourly: queues a renewal for every calendar whose watch channel ends within a day, or that has none. */
export function renewCalendarChannels(database: postgres.Sql, now: Date = new Date()): Promise<CalendarJobSummary> {
  return forEachCalendarTenant(database, "renew", async (tenantDb, tenantId) => {
    const queued = await tenantDb`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
      select selection.tenant_id, 'calendar_selection', selection.id, ${CALENDAR_RENEW_EVENT}, jsonb_build_object('selectionId', selection.id),
        'calendar.renew:' || selection.id || ':' || ${bucket(now, 60)}::text
      from calendar_selections as selection
      join calendar_connections as connection on connection.tenant_id = selection.tenant_id and connection.id = selection.connection_id
      where selection.tenant_id = ${tenantId} and connection.status = 'active' and connection.provider in ('google', 'microsoft')
        and (selection.blocks_availability or selection.writes_here)
        and (selection.channel_id is null or selection.channel_expires_at < ${now}::timestamptz + interval '25 hours')
      on conflict (tenant_id, dedupe_key) do nothing
      returning id`;
    return queued.length;
  });
}

/** Every 5 minutes: reads the calendars that cannot ping us (Apple, and Google or Outlook without a channel). */
export function pollCalendars(database: postgres.Sql, now: Date = new Date()): Promise<CalendarJobSummary> {
  return forEachCalendarTenant(database, "poll", async (tenantDb, tenantId) => {
    const queued = await tenantDb`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
      select selection.tenant_id, 'calendar_selection', selection.id, ${CALENDAR_SYNC_EVENT}, jsonb_build_object('selectionId', selection.id),
        'calendar.sync:' || selection.id || ':poll:' || ${bucket(now, 5)}::text
      from calendar_selections as selection
      join calendar_connections as connection on connection.tenant_id = selection.tenant_id and connection.id = selection.connection_id
      where selection.tenant_id = ${tenantId} and connection.status = 'active'
        and (selection.blocks_availability or selection.writes_here)
        and (connection.provider = 'apple' or selection.channel_id is null)
      on conflict (tenant_id, dedupe_key) do nothing
      returning id`;
    return queued.length;
  });
}

/** Hourly: calendars not fully re-read for 20 hours get a fresh snapshot, so the saved window never goes stale. Also tidies old webhook records. */
export function resnapshotCalendars(database: postgres.Sql, now: Date = new Date()): Promise<CalendarJobSummary> {
  return forEachCalendarTenant(database, "resnapshot", async (tenantDb, tenantId) => {
    const queued = await tenantDb`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
      select selection.tenant_id, 'calendar_selection', selection.id, ${CALENDAR_SYNC_EVENT},
        jsonb_build_object('selectionId', selection.id, 'resnapshot', true),
        'calendar.sync:' || selection.id || ':snapshot:' || ${bucket(now, 60)}::text
      from calendar_selections as selection
      join calendar_connections as connection on connection.tenant_id = selection.tenant_id and connection.id = selection.connection_id
      where selection.tenant_id = ${tenantId} and connection.status = 'active' and selection.blocks_availability
        and (selection.last_snapshot_at is null or selection.last_snapshot_at < ${now}::timestamptz - interval '20 hours')
      on conflict (tenant_id, dedupe_key) do nothing
      returning id`;
    const old = await tenantDb`delete from calendar_webhook_events where tenant_id = ${tenantId} and received_at < ${now}::timestamptz - interval '7 days' returning id`;
    return queued.length + old.length;
  });
}
