import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { adminMessageRowSchema, type AdminMessageRow } from "@/lib/admin-contracts";

import { adminCall, count, isoTime, isoTimeOrNull } from "./db";
import { explainMessage } from "./explain";

const notificationSchema = z.object({
  notification_id: z.string(),
  tenant_id: z.string(),
  appointment_id: z.string().nullable(),
  channel: z.string(),
  template_key: z.string(),
  status: z.string(),
  attempt_count: count,
  scheduled_at: isoTime,
  sent_at: isoTimeOrNull,
  delivered_at: isoTimeOrNull,
  failed_at: isoTimeOrNull,
  failure_code: z.string().nullable(),
  cost_category: z.string().nullable(),
  has_provider_id: z.boolean(),
});

const outboxSchema = z.object({
  event_id: z.string(),
  event_type: z.string(),
  status: z.string(),
  attempt_count: count,
  last_error_code: z.string().nullable(),
  available_at: isoTime,
});

/** Every message behind a notification or appointment id, with the outbox attempts behind each. Codes and times only. */
export async function findMessages(adminUserId: string, id: string, now: Date = new Date()): Promise<AdminMessageRow[]> {
  const found = z.array(notificationSchema).parse([...await adminCall((database) => database.execute(sql`select * from admin_find_notification(${adminUserId}, ${id})`))]);
  const result: AdminMessageRow[] = [];
  for (const row of found) {
    // The outbox event can be keyed by the notification or by its appointment; show both without repeats.
    const aggregates = [row.notification_id, ...(row.appointment_id ? [row.appointment_id] : [])];
    const events = new Map<string, z.infer<typeof outboxSchema>>();
    for (const aggregateId of aggregates) {
      const rows = z.array(outboxSchema).parse([...await adminCall((database) => database.execute(sql`select * from admin_find_outbox(${adminUserId}, ${row.tenant_id}, ${aggregateId})`))]);
      for (const event of rows) events.set(event.event_id, event);
    }
    result.push(adminMessageRowSchema.parse({
      notificationId: row.notification_id, tenantId: row.tenant_id, appointmentId: row.appointment_id, channel: row.channel,
      templateKey: row.template_key, status: row.status, attemptCount: row.attempt_count, scheduledAt: row.scheduled_at,
      sentAt: row.sent_at, deliveredAt: row.delivered_at, failedAt: row.failed_at, failureCode: row.failure_code,
      costCategory: row.cost_category, hasProviderId: row.has_provider_id,
      explanation: explainMessage({ status: row.status, failureCode: row.failure_code, attemptCount: row.attempt_count, scheduledAt: row.scheduled_at, channel: row.channel }, now),
      outbox: [...events.values()].map((event) => ({ eventId: event.event_id, eventType: event.event_type, status: event.status, attemptCount: event.attempt_count, lastErrorCode: event.last_error_code, availableAt: event.available_at })),
    }));
  }
  return result;
}
