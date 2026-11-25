import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents } from "@/db/schema";

import { ApiError } from "./api-error";
import { scopeFor } from "./bookings-list";
import { sendAlmostNext, waitingOrder } from "./queue-notify";
import { requirePermission, type StaffContext } from "./staff-context";

/**
 * Today's queue: token numbers for customers who are here, and calling them in.
 * A ticket always belongs to a visit. Where the customer is (waiting, in the room, done, left)
 * is the visit's own status, so Start, Done and Left stay the visit actions Today already has.
 */

export interface QueueTicketView {
  ticketId: string;
  appointmentId: string;
  number: number;
  calledAt: string | null;
  callCount: number;
  urgent: boolean;
}

export const callNextInputSchema = z.object({
  locationId: z.string().trim().min(1).max(80).optional(),
  /** Only call this practitioner's customers, for a room that serves one person. */
  practitionerId: z.string().trim().min(1).max(80).optional(),
}).strict();

export const queueTicketActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("call_again") }).strict(),
  z.object({ action: z.literal("skip") }).strict(),
  z.object({ action: z.literal("urgent"), reason: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("not_urgent") }).strict(),
]);

export type CallNextInput = z.infer<typeof callNextInputSchema>;
export type QueueTicketAction = z.infer<typeof queueTicketActionSchema>;

interface TicketRow extends Record<string, unknown> {
  id: string;
  appointment_id: string;
  number: number;
  called_at: Date | string | null;
  call_count: number;
  urgent: boolean;
}

function toView(row: TicketRow): QueueTicketView {
  return {
    ticketId: row.id,
    appointmentId: row.appointment_id,
    number: Number(row.number),
    calledAt: row.called_at ? new Date(row.called_at).toISOString() : null,
    callCount: Number(row.call_count),
    urgent: row.urgent,
  };
}

/**
 * Gives a visit its token number for today, at its location, if it has none yet.
 * The counter row is locked by the upsert, so two desks never get the same number.
 * Call inside the transaction that checks the customer in.
 */
export async function issueQueueTicket(
  transaction: KalendrTransaction,
  tenantId: string,
  appointmentId: string,
): Promise<number> {
  const existing = await transaction.execute<{ number: number }>(sql`
    select number from queue_tickets
    where tenant_id = ${tenantId} and appointment_id = ${appointmentId}
  `);
  if (existing[0]) return Number(existing[0].number);
  const place = await transaction.execute<{ location_id: string; day: string }>(sql`
    select appointment.location_id, (now() at time zone location.timezone)::date::text as day
    from appointments as appointment
    join locations as location
      on location.tenant_id = appointment.tenant_id and location.id = appointment.location_id
    where appointment.tenant_id = ${tenantId} and appointment.id = ${appointmentId}
  `);
  const visit = place[0];
  if (!visit) throw new ApiError(404, "appointment_not_found", "Appointment not found.");
  const counter = await transaction.execute<{ last_number: number }>(sql`
    insert into queue_counters (tenant_id, location_id, day, last_number)
    values (${tenantId}, ${visit.location_id}, ${visit.day}, 1)
    on conflict (tenant_id, location_id, day)
    do update set last_number = queue_counters.last_number + 1
    returning last_number
  `);
  const number = Number(counter[0]!.last_number);
  await transaction.execute(sql`
    insert into queue_tickets (tenant_id, location_id, day, number, appointment_id)
    values (${tenantId}, ${visit.location_id}, ${visit.day}, ${number}, ${appointmentId})
  `);
  return number;
}

/**
 * Calls the next customer who is waiting, in one transaction. The ticket is locked with
 * SKIP LOCKED, so two rooms pressing Call next at once get two different customers.
 * Order: urgent first, then booked customers whose time has come, then token order.
 * Customers who missed a call wait behind everyone else.
 */
export async function callNextTicket(context: StaffContext, input: CallNextInput): Promise<QueueTicketView | null> {
  requirePermission(context, "appointments.status");
  if (context.preview) throw new ApiError(400, "preview_only", "The queue is kept in this browser in the preview.");
  return withTenant(context.tenantId, async (transaction) => {
    const locationClause = input.locationId ? sql`and ticket.location_id = ${input.locationId}` : sql``;
    const practitionerClause = input.practitionerId ? sql`and appointment.practitioner_id = ${input.practitionerId}` : sql``;
    // A practitioner calls in their own customers only, whatever the Today filter says.
    const own = await scopeFor(transaction, context);
    const ownClause = own ? sql`and ${own}` : sql``;
    const next = await transaction.execute<{ id: string; location_id: string }>(sql`
      select ticket.id, ticket.location_id
      from queue_tickets as ticket
      join appointments as appointment
        on appointment.tenant_id = ticket.tenant_id and appointment.id = ticket.appointment_id
      join locations as location
        on location.tenant_id = ticket.tenant_id and location.id = ticket.location_id
      where ticket.tenant_id = ${context.tenantId}
        and ticket.day = (now() at time zone location.timezone)::date
        and ticket.called_at is null
        and appointment.status = 'checked_in'
        ${locationClause}
        ${practitionerClause}
        ${ownClause}
      order by ${waitingOrder}
      limit 1
      for update of ticket skip locked
    `);
    if (!next[0]) return null;
    const updated = await transaction.execute<TicketRow>(sql`
      update queue_tickets
      set called_at = now(), call_count = call_count + 1, skipped_at = null
      where tenant_id = ${context.tenantId} and id = ${next[0].id}
      returning id, appointment_id, number, called_at, call_count, urgent
    `);
    const row = updated[0]!;
    await audit(transaction, context, "queue.called", row);
    await sendAlmostNext(transaction, context.tenantId, next[0].location_id);
    return toView(row);
  });
}

/** Call again, skip, or mark a ticket urgent. Only for customers who are still waiting or called. */
export async function updateQueueTicket(
  context: StaffContext,
  ticketId: string,
  input: QueueTicketAction,
): Promise<QueueTicketView> {
  requirePermission(context, "appointments.status");
  if (context.preview) throw new ApiError(400, "preview_only", "The queue is kept in this browser in the preview.");
  return withTenant(context.tenantId, async (transaction) => {
    // Another practitioner's customer is not in this practitioner's queue at all.
    const own = await scopeFor(transaction, context);
    const ownClause = own ? sql`and ${own}` : sql``;
    const current = await transaction.execute<TicketRow & { status: string; location_id: string }>(sql`
      select ticket.id, ticket.appointment_id, ticket.number, ticket.called_at, ticket.call_count,
        ticket.urgent, appointment.status, ticket.location_id
      from queue_tickets as ticket
      join appointments as appointment
        on appointment.tenant_id = ticket.tenant_id and appointment.id = ticket.appointment_id
      where ticket.tenant_id = ${context.tenantId} and ticket.id = ${ticketId}
        ${ownClause}
      for update of ticket
    `);
    const ticket = current[0];
    if (!ticket) throw new ApiError(404, "ticket_not_found", "That token is no longer in today's queue.");
    if (ticket.status !== "checked_in") {
      throw new ApiError(409, "ticket_not_waiting", "This customer is no longer waiting.");
    }
    const change = input.action === "call_again"
      ? sql`called_at = now(), call_count = call_count + 1, skipped_at = null`
      : input.action === "skip"
        ? sql`called_at = null, skipped_at = now()`
        : input.action === "urgent"
          ? sql`urgent = true, urgent_reason = ${input.reason}, urgent_by_user_id = ${context.userId}`
          : sql`urgent = false, urgent_reason = null, urgent_by_user_id = null`;
    const updated = await transaction.execute<TicketRow>(sql`
      update queue_tickets set ${change}
      where tenant_id = ${context.tenantId} and id = ${ticketId}
      returning id, appointment_id, number, called_at, call_count, urgent
    `);
    const row = updated[0]!;
    await audit(transaction, context, `queue.${input.action}`, row);
    await sendAlmostNext(transaction, context.tenantId, ticket.location_id);
    return toView(row);
  });
}

async function audit(transaction: KalendrTransaction, context: StaffContext, action: string, row: TicketRow) {
  // The reason for urgent stays on the ticket; the audit keeps who and when, never names.
  await transaction.insert(auditEvents).values({
    tenantId: context.tenantId,
    actorUserId: context.userId,
    actorType: "staff",
    action,
    outcome: "success",
    appointmentId: row.appointment_id,
    metadata: { ticketId: row.id, number: Number(row.number) },
  });
}
