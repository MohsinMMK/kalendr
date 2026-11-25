/**
 * Applies a business's retention policy (the nightly job calls this once per business, inside that business's
 * transaction) and returns what it removed. Sign-in codes belong to no business, so they are removed once per run by
 * `deleteExpiredLoginCodes`. Counts only: nothing here reads or returns a name, contact or message text.
 *
 * No "server-only" import: the worker uses this file.
 */
import type postgres from "postgres";

import { effectiveRetention, type RetentionKind } from "./rules";

type TenantDb = postgres.TransactionSql;

export interface RetentionCounts {
  messageLog: number;
  cancelledBookings: number;
  finishedOutbox: number;
  erasedRecords: number;
}

export const emptyRetentionCounts: RetentionCounts = { messageLog: 0, cancelledBookings: 0, finishedOutbox: 0, erasedRecords: 0 };

export function totalRetention(counts: RetentionCounts): number {
  return counts.messageLog + counts.cancelledBookings + counts.finishedOutbox + counts.erasedRecords;
}

/** Sign-in codes older than a day, and customer sessions that ended more than a day ago. Returns how many codes went. */
export async function deleteExpiredLoginCodes(database: postgres.Sql): Promise<{ codes: number; sessions: number }> {
  const codes = await database`delete from patient_login_codes where created_at < now() - interval '1 day' returning id`;
  const sessions = await database`delete from patient_sessions where expires_at < now() - interval '1 day' returning id`;
  return { codes: codes.length, sessions: sessions.length };
}

/**
 * One business's nightly clean-up, from its own settings (or the defaults for its type). Writes one audit row with the
 * counts when anything was removed.
 */
export async function applyTenantRetention(tenantDb: TenantDb, tenantId: string): Promise<RetentionCounts> {
  const [tenant] = await tenantDb<{ business_type: string }[]>`select business_type from tenants where id = ${tenantId}`;
  const stored = await tenantDb<{ data_kind: RetentionKind; keep_days: number; action: "delete" | "anonymise" }[]>`
    select data_kind, keep_days, action from retention_policies where tenant_id = ${tenantId}
  `;
  const policy = effectiveRetention(tenant?.business_type ?? "healthcare", stored.map((row) => ({ dataKind: row.data_kind, keepDays: row.keep_days, action: row.action })));

  const messages = await tenantDb`
    delete from notifications where tenant_id = ${tenantId} and created_at < now() - ${policy.message_log.keepDays} * interval '1 day' returning id
  `;
  // The booking stays so reports add up; what a person wrote on it goes.
  const bookings = await tenantDb`
    update appointments set notes = null, reason_for_visit = null, custom_fields = '{}'::jsonb, updated_at = now()
    where tenant_id = ${tenantId} and status in ('cancelled', 'no_show')
      and ends_at < now() - ${policy.cancelled_booking_details.keepDays} * interval '1 day'
      and (notes is not null or reason_for_visit is not null or custom_fields <> '{}'::jsonb)
    returning id
  `;
  const outbox = await tenantDb`
    delete from outbox_events
    where tenant_id = ${tenantId} and status = 'delivered' and updated_at < now() - ${policy.finished_outbox.keepDays} * interval '1 day'
    returning id
  `;
  // Records kept for an erased customer are removed once the business's record period is over.
  const records = await tenantDb<{ id: string }[]>`
    select record.id from visit_records as record
    join patients as patient on patient.tenant_id = record.tenant_id and patient.id = record.patient_id
    where record.tenant_id = ${tenantId} and patient.erased_at is not null
      and record.created_at < now() - ${policy.medical_records.keepDays} * interval '1 day'
  `;
  if (records.length > 0) {
    const ids = records.map((row) => row.id);
    const files = await tenantDb<{ storage_key: string }[]>`select storage_key from visit_record_files where tenant_id = ${tenantId} and record_id in ${tenantDb(ids)}`;
    for (const file of files) {
      await tenantDb`
        insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
        values (${tenantId}, 'file', ${file.storage_key}, 'file.remove', ${tenantDb.json({ key: file.storage_key })}, ${`file.remove:${file.storage_key}`.slice(0, 200)})
        on conflict (tenant_id, dedupe_key) do nothing
      `;
    }
    await tenantDb`delete from visit_records where tenant_id = ${tenantId} and id in ${tenantDb(ids)}`;
  }

  const counts: RetentionCounts = {
    messageLog: messages.length,
    cancelledBookings: bookings.length,
    finishedOutbox: outbox.length,
    erasedRecords: records.length,
  };
  if (totalRetention(counts) > 0) {
    await tenantDb`
      insert into audit_events (tenant_id, actor_type, action, outcome, metadata)
      values (${tenantId}, 'system', 'privacy.retention.applied', 'success', ${tenantDb.json({ ...counts })})
    `;
  }
  return counts;
}

/**
 * Queues one email to the business for each open request past its due date that has not been mentioned yet. The
 * `overdue_alerted_at` column is what makes it once per request; the outbox row's key is a second guard.
 */
export async function queueOverdueAlerts(tenantDb: TenantDb, tenantId: string): Promise<number> {
  const due = await tenantDb<{ id: string; type: string; due_at: Date }[]>`
    select id, type, due_at from data_requests
    where tenant_id = ${tenantId} and status in ('requested', 'approved', 'processing') and due_at < now() and overdue_alerted_at is null
    for update
  `;
  for (const request of due) {
    await tenantDb`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
      values (${tenantId}, 'data_request', ${request.id}, 'privacy.request.overdue', ${tenantDb.json({ requestId: request.id })}, ${`privacy.request.overdue:${request.id}`})
      on conflict (tenant_id, dedupe_key) do nothing
    `;
    await tenantDb`update data_requests set overdue_alerted_at = now() where tenant_id = ${tenantId} and id = ${request.id}`;
    await tenantDb`
      insert into audit_events (tenant_id, actor_type, action, outcome, metadata)
      values (${tenantId}, 'system', 'privacy.request.overdue_alert', 'success', ${tenantDb.json({ requestId: request.id, type: request.type })})
    `;
  }
  return due.length;
}
