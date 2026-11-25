import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { withTenant } from "@/db/client";
import { auditEvents, idempotencyKeys } from "@/db/schema";

import { ApiError } from "./api-error";
import { canonicalJsonHash } from "./crypto";
import { isPreviewMode } from "./preview-repository";
import { requirePermission, type StaffContext } from "./staff-context";

/** "failed" is still being retried by the worker; "dead_letter" means the worker gave up. */
export const undeliveredFilters = ["all", "failed", "dead_letter"] as const;
export type UndeliveredFilter = (typeof undeliveredFilters)[number];

export interface UndeliveredMessage {
  id: string;
  eventType: string;
  status: "failed" | "dead_letter";
  /** How many times the worker has tried. Sent back with "Try again" so a stale screen cannot reset a newer state. */
  attemptCount: number;
  /** A short machine code such as `provider_not_configured`. Never a provider's message or a recipient. */
  lastErrorCode: string | null;
  updatedAt: string;
  appointmentId: string | null;
  patientId: string | null;
  startsAt: string | null;
}

export const retryInput = z.object({ attemptCount: z.number().int().min(0).max(32_767) }).strict();
export type RetryInput = z.infer<typeof retryInput>;

const RETRY_ROUTE = "staff.messages.retry";
const pageSize = 50;

type Row = {
  id: string;
  event_type: string;
  status: "failed" | "dead_letter";
  attempt_count: number;
  last_error_code: string | null;
  updated_at: Date | string;
  appointment_id: string | null;
  patient_id: string | null;
  starts_at: Date | string | null;
};

const iso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();

/** Messages the worker could not send, newest first. Only the ids and the error code leave the database. */
export async function listUndeliveredMessages(context: StaffContext, filter: UndeliveredFilter): Promise<UndeliveredMessage[]> {
  requirePermission(context, "messages.retry");
  if (context.preview || isPreviewMode()) return [];
  const statuses = filter === "all" ? sql`('failed', 'dead_letter')` : filter === "failed" ? sql`('failed')` : sql`('dead_letter')`;
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.execute<Row>(sql`
      select event.id, event.event_type, event.status, event.attempt_count, event.last_error_code, event.updated_at,
             appointment.id as appointment_id, appointment.patient_id, appointment.starts_at
      from outbox_events event
      left join visit_records record
        on event.aggregate_type = 'visit_record' and record.tenant_id = event.tenant_id and record.id = event.aggregate_id
      left join appointments appointment
        on appointment.tenant_id = event.tenant_id
       and appointment.id = case when event.aggregate_type = 'appointment' then event.aggregate_id else record.appointment_id end
      where event.tenant_id = ${context.tenantId} and event.status in ${statuses}
        and event.event_type <> 'push.send' -- an alert that did not reach a phone is not a customer message
      order by event.updated_at desc, event.id
      limit ${pageSize}
    `);
    return rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      status: row.status,
      attemptCount: Number(row.attempt_count),
      lastErrorCode: row.last_error_code,
      updatedAt: iso(row.updated_at),
      appointmentId: row.appointment_id,
      patientId: row.patient_id,
      startsAt: row.starts_at ? iso(row.starts_at) : null,
    }));
  });
}

export interface RetryResult {
  id: string;
  status: "pending";
}

/**
 * Puts one failed or dead-lettered message back in the queue: status pending, attempts back to
 * zero, available now. The worker picks it up on its next claim. `attemptCount` is the version the
 * screen saw; if the worker has touched the row since, the reset is refused with 409.
 */
export async function retryUndeliveredMessage(
  context: StaffContext,
  eventId: string,
  input: RetryInput,
  idempotencyKey: string,
): Promise<RetryResult> {
  requirePermission(context, "messages.retry");
  if (context.preview || isPreviewMode()) throw new ApiError(409, "preview_only", "Messages are not sent in the preview.");
  const requestHash = canonicalJsonHash({ eventId, attemptCount: input.attemptCount });
  return withTenant(context.tenantId, async (transaction) => {
    const key = await transaction.insert(idempotencyKeys).values({
      tenantId: context.tenantId,
      route: RETRY_ROUTE,
      key: idempotencyKey,
      requestHash,
    }).onConflictDoNothing().returning({ id: idempotencyKeys.id });
    if (key.length === 0) {
      const existing = await transaction.execute<{ request_hash: string }>(sql`
        select request_hash from idempotency_keys
        where tenant_id = ${context.tenantId} and route = ${RETRY_ROUTE} and key = ${idempotencyKey}
        for update
      `);
      if (existing[0]?.request_hash !== requestHash) {
        throw new ApiError(409, "idempotency_conflict", "That Idempotency-Key was already used for a different request.");
      }
      return { id: eventId, status: "pending" };
    }

    const reset = await transaction.execute<{ event_type: string; previous_status: string; previous_error: string | null; appointment_id: string | null }>(sql`
      with target as (
        select id, status, last_error_code from outbox_events
        where tenant_id = ${context.tenantId} and id = ${eventId}
          and status in ('failed', 'dead_letter') and attempt_count = ${input.attemptCount}
        for update
      )
      update outbox_events event
      set status = 'pending', attempt_count = 0, available_at = now(), locked_at = null, locked_by = null,
          last_error_code = null, updated_at = now()
      from target
      where event.tenant_id = ${context.tenantId} and event.id = target.id
      returning event.event_type, target.status::text as previous_status, target.last_error_code as previous_error,
        case when event.aggregate_type = 'appointment' then event.aggregate_id else null end as appointment_id
    `);
    const row = reset[0];
    if (!row) {
      const current = await transaction.execute<{ status: string }>(sql`
        select status::text as status from outbox_events where tenant_id = ${context.tenantId} and id = ${eventId}
      `);
      if (!current[0]) throw new ApiError(404, "message_not_found", "Message not found.");
      throw new ApiError(409, "message_changed", "This message changed since the list was loaded. Refresh and try again.");
    }

    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      appointmentId: row.appointment_id,
      actorUserId: context.userId,
      actorType: "staff",
      action: "message.retry",
      outcome: "success",
      metadata: { eventId, eventType: row.event_type, from: row.previous_status, errorCode: row.previous_error, attemptCount: input.attemptCount },
    });
    await transaction.execute(sql`
      update idempotency_keys set response_status = 200, response_body = ${JSON.stringify({ id: eventId, status: "pending" })}::jsonb
      where id = ${key[0]!.id}
    `);
    return { id: eventId, status: "pending" };
  });
}
