import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents, outboxEvents } from "@/db/schema";
import { MAX_DELAY_MINUTES, MIN_DELAY_MINUTES, QUICK_MESSAGE_EVENT } from "@/lib/quick-messages";

import { ApiError } from "./api-error";
import { scopeFor } from "./bookings-list";
import { requirePermission, type StaffContext } from "./staff-context";
import { currentTraceParent } from "./tracing";

/**
 * Quick messages from Today: "It's your turn", "Running late" and "Please call us".
 * Nothing is sent here. Each message is an outbox row written in the same transaction as its
 * audit row; the worker renders and delivers it.
 */

const delayMinutes = z.number().int().min(MIN_DELAY_MINUTES).max(MAX_DELAY_MINUTES);

export const quickMessageInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("your_turn") }).strict(),
  z.object({ kind: z.literal("call_us") }).strict(),
  z.object({ kind: z.literal("running_late"), delayMinutes }).strict(),
]);

export const delayNoticeInputSchema = z.object({
  delayMinutes,
  /** Only this practitioner's customers, when one person is running late. */
  practitionerId: z.string().trim().min(1).max(80).optional(),
}).strict();

export type QuickMessageInput = z.infer<typeof quickMessageInputSchema>;
export type DelayNoticeInput = z.infer<typeof delayNoticeInputSchema>;

/** A customer can be told about a visit that is still ahead or in the waiting room. */
const messageableStatuses = new Set(["requested", "booked", "checked_in"]);

/** The same message to the same customer this soon after is almost always a double tap. */
const REPEAT_WINDOW_MINUTES = 2;

async function queueMessage(
  transaction: KalendrTransaction,
  context: StaffContext,
  appointment: { id: string; version: number },
  input: QuickMessageInput,
  sendKey: string,
): Promise<boolean> {
  const inserted = await transaction.insert(outboxEvents).values({
    tenantId: context.tenantId,
    aggregateType: "appointment",
    aggregateId: appointment.id,
    eventType: QUICK_MESSAGE_EVENT,
    payload: { appointmentId: appointment.id, version: appointment.version, ...input },
    dedupeKey: `quick:${appointment.id}:${sendKey}`.slice(0, 200),
    traceParent: currentTraceParent(),
  }).onConflictDoNothing().returning({ id: outboxEvents.id });
  if (!inserted.length) return false;
  await transaction.insert(auditEvents).values({
    tenantId: context.tenantId,
    actorUserId: context.userId,
    actorType: "staff",
    action: "message.quick_sent",
    outcome: "success",
    appointmentId: appointment.id,
    metadata: input,
  });
  return true;
}

/** Sends one customer a quick message about their visit. */
export async function sendQuickMessage(
  context: StaffContext,
  appointmentId: string,
  input: QuickMessageInput,
  idempotencyKey: string,
): Promise<{ queued: boolean }> {
  requirePermission(context, "appointments.status");
  if (context.preview) throw new ApiError(400, "preview_only", "Messages stay in this browser in the preview.");
  return withTenant(context.tenantId, async (transaction) => {
    // A practitioner messages their own customers only; anyone else's visit is not found.
    const own = await scopeFor(transaction, context);
    const ownClause = own ? sql`and ${own}` : sql``;
    const rows = await transaction.execute<{ id: string; version: number; status: string; recent: boolean }>(sql`
      select appointment.id, appointment.version, appointment.status,
        exists (
          select 1 from outbox_events as event
          where event.tenant_id = appointment.tenant_id
            and event.aggregate_id = appointment.id
            and event.event_type = ${QUICK_MESSAGE_EVENT}
            and event.payload ->> 'kind' = ${input.kind}
            and event.created_at > now() - make_interval(mins => ${REPEAT_WINDOW_MINUTES})
        ) as recent
      from appointments as appointment
      where appointment.tenant_id = ${context.tenantId} and appointment.id = ${appointmentId}
        ${ownClause}
      for update of appointment
    `);
    const appointment = rows[0];
    if (!appointment) throw new ApiError(404, "appointment_not_found", "Appointment not found.");
    if (!messageableStatuses.has(appointment.status)) {
      throw new ApiError(409, "appointment_not_active", "This visit is finished or cancelled, so there is nothing to tell them.");
    }
    const version = Number(appointment.version);
    const replay = await transaction.execute<{ id: string }>(sql`
      select id from outbox_events
      where tenant_id = ${context.tenantId} and dedupe_key = ${`quick:${appointment.id}:${idempotencyKey}`.slice(0, 200)}
    `);
    if (replay[0]) return { queued: true };
    if (appointment.recent) {
      throw new ApiError(409, "message_recently_sent", "This message was sent less than 2 minutes ago.");
    }
    return { queued: await queueMessage(transaction, context, { id: appointment.id, version }, input, idempotencyKey) };
  });
}

/**
 * Tells everyone still to be seen today that the business is running late: customers who are
 * booked or waiting, whose visit has not started. Returns how many were told.
 */
export async function sendDelayNotice(
  context: StaffContext,
  input: DelayNoticeInput,
  idempotencyKey: string,
): Promise<{ count: number }> {
  requirePermission(context, "appointments.status");
  if (context.preview) throw new ApiError(400, "preview_only", "Messages stay in this browser in the preview.");
  return withTenant(context.tenantId, async (transaction) => {
    const practitionerClause = input.practitionerId ? sql`and appointment.practitioner_id = ${input.practitionerId}` : sql``;
    // "Running late" from a practitioner tells their own customers, never the whole business.
    const own = await scopeFor(transaction, context);
    const ownClause = own ? sql`and ${own}` : sql``;
    const rows = await transaction.execute<{ id: string; version: number }>(sql`
      select appointment.id, appointment.version
      from appointments as appointment
      join locations as location
        on location.tenant_id = appointment.tenant_id and location.id = appointment.location_id
      where appointment.tenant_id = ${context.tenantId}
        and appointment.status in ('booked', 'checked_in')
        and appointment.visit_started_at is null
        and (appointment.starts_at at time zone location.timezone)::date = (now() at time zone location.timezone)::date
        ${practitionerClause}
        ${ownClause}
      order by appointment.starts_at, appointment.id
      limit 200
      for update of appointment
    `);
    let count = 0;
    for (const row of rows) {
      const message: QuickMessageInput = { kind: "running_late", delayMinutes: input.delayMinutes };
      if (await queueMessage(transaction, context, { id: row.id, version: Number(row.version) }, message, `delay:${idempotencyKey}`)) count += 1;
    }
    return { count };
  });
}
