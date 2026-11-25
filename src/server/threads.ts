import "server-only";

/**
 * The Inbox: one conversation per customer per channel. Reading opens the sealed message text
 * with the business's data key; replying seals the text and queues it for the worker, so no
 * request calls WhatsApp. Everything runs inside the business's row-level security scope.
 */
import { sql } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents, messageThreads, outboxEvents, threadMessages } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import type {
  InboxFilter, ReplyInput, ThreadAppointment, ThreadDetail, ThreadMessage, ThreadMessageStatus, ThreadSummary,
} from "@/lib/inbox-contracts";
import { replyTemplateKeys } from "@/lib/channel-templates";

import { ApiError } from "./api-error";
import { claimKey, finishKey } from "./idempotent";
import { andLocation, andVisibleCustomer } from "./location-scope";
import { isPreviewMode } from "./preview-repository";
import { loadRecordKeys, openText, sealText, writeKeyVersion } from "./record-crypto";
import { requirePermission, type StaffContext } from "./staff-context";
import { currentTraceParent } from "./tracing";

const TEMPLATE_LABELS: Record<string, string> = {
  booking_confirmed: "Booking confirmation sent",
  reminder: "Reminder sent",
  rescheduled: "New time sent",
  cancelled: "Cancellation sent",
  waitlist_offer: "Opening offered",
  series_confirmed: "Repeating bookings confirmed",
  review_request: "Review request sent",
};

const REPLY_LABELS: Record<(typeof replyTemplateKeys)[number], string> = {
  reminder: "Send the reminder again",
  booking_confirmed: "Send the booking confirmation again",
  rescheduled: "Send the booking's time again",
};

const PAGE = 60;

type ThreadRow = {
  id: string; patient_id: string; first_name: string; last_name: string; unread_count: number;
  last_message_at: Date; window_closes_at: Date | null; assigned_to_user_id: string | null;
  last_kind: string | null; last_body: string | null; last_template: string | null; last_direction: string | null;
};

const iso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();

function windowOpen(closesAt: Date | null, now = new Date()): boolean {
  return closesAt !== null && new Date(closesAt).getTime() > now.getTime();
}

function previewLine(row: ThreadRow, tenantId: string): string {
  if (row.last_kind === "template") return TEMPLATE_LABELS[row.last_template ?? ""] ?? "Message sent";
  if (row.last_body) return openText(tenantId, row.last_body).slice(0, 140);
  return row.last_kind === "other" ? "Sent a picture or voice note" : "";
}

function summary(row: ThreadRow, tenantId: string): ThreadSummary {
  return {
    id: row.id,
    patientId: row.patient_id,
    patientName: `${row.first_name} ${row.last_name}`.trim(),
    channel: "whatsapp",
    unreadCount: Number(row.unread_count),
    lastMessageAt: iso(row.last_message_at),
    preview: previewLine(row, tenantId),
    windowOpen: windowOpen(row.window_closes_at),
    assignedToUserId: row.assigned_to_user_id,
  };
}

const threadSelect = sql`
  select thread.id, thread.patient_id, patient.first_name, patient.last_name, thread.unread_count,
    thread.last_message_at, thread.window_closes_at, thread.assigned_to_user_id,
    last.kind as last_kind, last.body_ciphertext as last_body, last.template_key as last_template,
    last.direction as last_direction
  from message_threads as thread
  join patients as patient on patient.tenant_id = thread.tenant_id and patient.id = thread.patient_id
  left join lateral (
    select kind, body_ciphertext, template_key, direction from messages
    where messages.tenant_id = thread.tenant_id and messages.thread_id = thread.id
    order by messages.created_at desc limit 1
  ) as last on true
`;

export async function listThreads(context: StaffContext, filter: InboxFilter): Promise<ThreadSummary[]> {
  requirePermission(context, "inbox.reply");
  if (context.preview || isPreviewMode()) return [];
  return withTenant(context.tenantId, async (transaction) => {
    await loadRecordKeys(transaction, context.tenantId);
    const where = filter === "unread" ? sql`and thread.unread_count > 0`
      : filter === "mine" ? sql`and thread.assigned_to_user_id = ${context.userId}`
        : sql``;
    const rows = await transaction.execute<ThreadRow>(sql`
      ${threadSelect}
      where thread.tenant_id = ${context.tenantId} ${where} ${andVisibleCustomer(context, sql`thread.patient_id`)}
      order by thread.last_message_at desc, thread.id
      limit ${PAGE}
    `);
    return rows.map((row) => summary(row, context.tenantId));
  });
}

/** A thread about a customer this person cannot see (they only visit other locations) is treated as missing. */
async function assertThreadVisible(transaction: KalendrTransaction, context: StaffContext, threadId: string): Promise<void> {
  const rows = await transaction.execute<{ id: string }>(sql`
    select thread.id from message_threads as thread
    where thread.tenant_id = ${context.tenantId} and thread.id = ${threadId} ${andVisibleCustomer(context, sql`thread.patient_id`)}
  `);
  if (!rows[0]) throw new ApiError(404, "thread_not_found", "That conversation was not found.");
}

async function loadThread(transaction: KalendrTransaction, context: StaffContext, threadId: string): Promise<ThreadRow> {
  const rows = await transaction.execute<ThreadRow>(sql`
    ${threadSelect} where thread.tenant_id = ${context.tenantId} and thread.id = ${threadId}
      ${andVisibleCustomer(context, sql`thread.patient_id`)}
  `);
  const row = rows[0];
  if (!row) throw new ApiError(404, "thread_not_found", "That conversation was not found.");
  return row;
}

export async function getThread(context: StaffContext, threadId: string): Promise<ThreadDetail> {
  requirePermission(context, "inbox.reply");
  if (context.preview || isPreviewMode()) throw new ApiError(404, "thread_not_found", "That conversation was not found.");
  return withTenant(context.tenantId, async (transaction) => {
    await loadRecordKeys(transaction, context.tenantId);
    const row = await loadThread(transaction, context, threadId);
    const messageRows = await transaction.execute<{
      id: string; direction: "inbound" | "outbound"; kind: ThreadMessage["kind"]; body_ciphertext: string | null;
      template_key: string | null; status: ThreadMessageStatus; failure_code: string | null; created_at: Date;
    }>(sql`
      select id, direction, kind, body_ciphertext, template_key, status, failure_code, created_at
      from messages where tenant_id = ${context.tenantId} and thread_id = ${threadId}
      order by created_at desc, id limit 200
    `);
    const next = await transaction.execute<{
      id: string; starts_at: Date; service_name: string; practitioner_name: string; status: string; confirmation_status: string;
    }>(sql`
      select appointment.id, appointment.starts_at, service.name as service_name, practitioner.name as practitioner_name,
        appointment.status, appointment.confirmation_status
      from appointments as appointment
      join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
      join practitioners as practitioner on practitioner.tenant_id = appointment.tenant_id and practitioner.id = appointment.practitioner_id
      where appointment.tenant_id = ${context.tenantId} and appointment.patient_id = ${row.patient_id}
        ${andLocation(context, sql`appointment.location_id`)}
        and appointment.status in ('requested', 'booked') and appointment.starts_at > now()
      order by appointment.starts_at limit 1
    `);
    const appointment: ThreadAppointment | null = next[0]
      ? {
        id: next[0].id, startsAt: iso(next[0].starts_at), serviceName: next[0].service_name,
        practitionerName: next[0].practitioner_name, status: next[0].status, confirmationStatus: next[0].confirmation_status,
      }
      : null;
    return {
      thread: summary(row, context.tenantId),
      messages: messageRows.reverse().map((message) => ({
        id: message.id,
        direction: message.direction,
        kind: message.kind,
        text: message.body_ciphertext ? openText(context.tenantId, message.body_ciphertext) : null,
        templateLabel: message.kind === "template" ? TEMPLATE_LABELS[message.template_key ?? ""] ?? "Message sent" : null,
        status: message.status,
        failureCode: message.failure_code,
        createdAt: iso(message.created_at),
      })),
      nextAppointment: appointment,
      windowClosesAt: row.window_closes_at ? iso(row.window_closes_at) : null,
      replyTemplates: appointment ? replyTemplateKeys.map((key) => ({ key, label: REPLY_LABELS[key] })) : [],
    };
  });
}

/** Clears the unread count when staff open a conversation. Safe to repeat. */
export async function markThreadRead(context: StaffContext, threadId: string): Promise<{ unreadCount: number }> {
  requirePermission(context, "inbox.reply");
  if (context.preview || isPreviewMode()) return { unreadCount: 0 };
  return withTenant(context.tenantId, async (transaction) => {
    await assertThreadVisible(transaction, context, threadId);
    const updated = await transaction.update(messageThreads).set({ unreadCount: 0, updatedAt: new Date() })
      .where(and(eq(messageThreads.tenantId, context.tenantId), eq(messageThreads.id, threadId)))
      .returning({ id: messageThreads.id });
    if (updated.length === 0) throw new ApiError(404, "thread_not_found", "That conversation was not found.");
    return { unreadCount: 0 };
  });
}

export async function assignThread(context: StaffContext, threadId: string, userId: string | null): Promise<{ assignedToUserId: string | null }> {
  requirePermission(context, "inbox.reply");
  if (context.preview || isPreviewMode()) throw new ApiError(409, "preview_only", "The Inbox is not available in the preview.");
  return withTenant(context.tenantId, async (transaction) => {
    await assertThreadVisible(transaction, context, threadId);
    if (userId) {
      const member = await transaction.execute<{ user_id: string }>(sql`
        select user_id from memberships where tenant_id = ${context.tenantId} and user_id = ${userId} and is_active limit 1
      `);
      if (!member[0]) throw new ApiError(404, "staff_not_found", "That person is not on your team.");
    }
    const updated = await transaction.update(messageThreads).set({ assignedToUserId: userId, updatedAt: new Date() })
      .where(and(eq(messageThreads.tenantId, context.tenantId), eq(messageThreads.id, threadId)))
      .returning({ id: messageThreads.id });
    if (updated.length === 0) throw new ApiError(404, "thread_not_found", "That conversation was not found.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "thread.assign", outcome: "success",
      metadata: { threadId, assigned: userId !== null },
    });
    return { assignedToUserId: userId };
  });
}

export interface ReplyResult { messageId: string; status: "queued" }

/**
 * Queues a reply. Free text is refused when the customer's 24-hour window has closed (WhatsApp
 * would refuse it too), with a message that says what to do instead. The worker sends it.
 */
export async function sendThreadReply(context: StaffContext, threadId: string, input: ReplyInput, idempotencyKey: string): Promise<ReplyResult> {
  requirePermission(context, "inbox.reply");
  if (context.preview || isPreviewMode()) throw new ApiError(409, "preview_only", "Messages are not sent in the preview.");
  return withTenant(context.tenantId, async (transaction) => {
    const route = "staff.threads.reply";
    const claim = await claimKey<ReplyResult>(transaction, context.tenantId, route, idempotencyKey, { threadId, ...input });
    if ("replay" in claim) return claim.replay;

    const row = await loadThread(transaction, context, threadId);
    if (input.kind === "text" && !windowOpen(row.window_closes_at)) {
      throw new ApiError(409, "window_closed", "It has been more than 24 hours since they wrote, so WhatsApp only lets you send an approved message. Choose one from the list.");
    }
    if (input.kind === "template") {
      const booking = await transaction.execute<{ id: string }>(sql`
        select id from appointments where tenant_id = ${context.tenantId} and id = ${input.appointmentId} and patient_id = ${row.patient_id}
          ${andLocation(context, sql`location_id`)}
      `);
      if (!booking[0]) throw new ApiError(404, "appointment_not_found", "That booking was not found for this customer.");
    }
    await loadRecordKeys(transaction, context.tenantId, { forWrite: true });
    const [message] = await transaction.insert(threadMessages).values({
      tenantId: context.tenantId,
      threadId,
      direction: "outbound",
      kind: input.kind === "text" ? "text" : "template",
      bodyCiphertext: input.kind === "text" ? sealText(context.tenantId, input.body) : null,
      keyVersion: input.kind === "text" ? writeKeyVersion(context.tenantId) : null,
      templateKey: input.kind === "template" ? input.templateKey : null,
      status: "queued",
      sentByUserId: context.userId,
      appointmentId: input.kind === "template" ? input.appointmentId : null,
    }).returning({ id: threadMessages.id });
    if (!message) throw new Error("Message insert did not return a row");
    await transaction.insert(outboxEvents).values({
      tenantId: context.tenantId,
      aggregateType: "thread",
      aggregateId: threadId,
      eventType: "thread.reply",
      payload: input.kind === "text"
        ? { messageId: message.id }
        : { messageId: message.id, templateKey: input.templateKey, appointmentId: input.appointmentId },
      dedupeKey: `reply:${message.id}`,
      traceParent: currentTraceParent(),
    });
    await transaction.update(messageThreads).set({ unreadCount: 0, lastMessageAt: new Date(), updatedAt: new Date() })
      .where(and(eq(messageThreads.tenantId, context.tenantId), eq(messageThreads.id, threadId)));
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "thread.reply", outcome: "success",
      metadata: { threadId, kind: input.kind },
    });
    const result: ReplyResult = { messageId: message.id, status: "queued" };
    await finishKey(transaction, claim.claimId, result);
    return result;
  });
}
