import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { getDatabase, withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents } from "@/db/schema";

import { ApiError } from "./api-error";
import { createOpaqueToken, sha256 } from "./crypto";
import { isPreviewMode } from "./preview-repository";
import { ALMOST_NEXT_AHEAD, sendAlmostNext, waitingOrder } from "./queue-notify";
import { andLocation } from "./location-scope";
import { requirePermission, type StaffContext } from "./staff-context";

/**
 * The waiting-room screen and the customer's own queue page. Both open from a secret link with
 * no sign-in, so they show token numbers and who is calling, never a customer's name or phone.
 */

export const queueTokenSchema = z.string().min(32).max(200).regex(/^[A-Za-z0-9_-]+$/);

export const screenLinkInputSchema = z.strictObject({
  locationId: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/).optional(),
});

export const ticketNotifyInputSchema = z.strictObject({ notifyWhenNext: z.boolean() });

export interface QueueScreen {
  businessName: string;
  locationName: string;
  /** The latest calls, newest first. */
  calling: { number: number; to: string; calledAt: string }[];
  /** The next tokens, in the order they will be called. */
  next: number[];
  waitingCount: number;
  at: string;
}

export type QueueTicketState = "waiting" | "called" | "with" | "done" | "left";

export interface QueueTicketStatus {
  businessName: string;
  locationName: string;
  number: number;
  state: QueueTicketState;
  /** People to be called before this customer. Only while waiting. */
  ahead: number;
  /** A rough range in minutes, or null when it is their turn or nothing is known yet. */
  wait: { low: number; high: number } | null;
  /** Who called them, once called. */
  calledTo: string | null;
  notifyWhenNext: boolean;
  /** Already told they are almost next. */
  notified: boolean;
  /** A phone number is on file, so a message can be sent. */
  canNotify: boolean;
  at: string;
}

export interface QueueLink {
  path: string;
}

const SCREEN_ROUTE_PATH = "/queue/";
const TICKET_ROUTE_PATH = "/q/";
/** How long a visit takes when there is no history yet. */
const DEFAULT_VISIT_MINUTES = 15;

function refusePreview(context: StaffContext): void {
  if (context.preview || isPreviewMode()) throw new ApiError(409, "preview_only", "Queue screens need the real database.");
}

const notFound = () => new ApiError(404, "queue_link_not_found", "This queue link is no longer active.");

// ── Staff: making links ─────────────────────────────────────────────────

/**
 * Makes the waiting-room screen's link for a location. Only one link works at a time: a new one
 * turns the old screen off, which is how a leaked link is stopped.
 */
export async function createScreenLink(context: StaffContext, input: z.infer<typeof screenLinkInputSchema>): Promise<QueueLink> {
  requirePermission(context, "appointments.status");
  refusePreview(context);
  const token = createOpaqueToken();
  await withTenant(context.tenantId, async (transaction) => {
    const [location] = await transaction.execute<{ id: string }>(sql`
      select id from locations
      where tenant_id = ${context.tenantId} ${input.locationId ? sql`and id = ${input.locationId}` : sql``}
        ${andLocation(context, sql`id`)}
      order by created_at asc limit 1
    `);
    if (!location) throw new ApiError(404, "location_not_found", "That location could not be found.");
    // The door QR code (feature 22) lives on the live row. It moves to the new row so replacing the screen's
    // link does not turn off the QR code printed at the door.
    const [old] = await transaction.execute<{ join_token_hash: string | null; self_join_enabled: boolean }>(sql`
      select join_token_hash, self_join_enabled from queue_displays
      where tenant_id = ${context.tenantId} and location_id = ${location.id} and revoked_at is null
      for update
    `);
    await transaction.execute(sql`
      update queue_displays set revoked_at = now(), join_token_hash = null
      where tenant_id = ${context.tenantId} and location_id = ${location.id} and revoked_at is null
    `);
    const [row] = await transaction.execute<{ id: string }>(sql`
      insert into queue_displays (tenant_id, location_id, token_hash, join_token_hash, self_join_enabled, created_by_user_id)
      values (${context.tenantId}, ${location.id}, ${sha256(token)}, ${old?.join_token_hash ?? null}, ${old?.self_join_enabled ?? true}, ${context.userId})
      returning id
    `);
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff",
      action: "queue.screen_link_made", outcome: "success",
      metadata: { displayId: row!.id, locationId: location.id },
    });
  });
  return { path: `${SCREEN_ROUTE_PATH}${token}` };
}

/** Makes the customer's own link to their place in today's queue. A new link replaces the old one. */
export async function createTicketLink(context: StaffContext, ticketId: string): Promise<QueueLink> {
  requirePermission(context, "appointments.status");
  refusePreview(context);
  const token = createOpaqueToken();
  await withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.execute<{ id: string; appointment_id: string; number: number }>(sql`
      update queue_tickets as ticket set phone_token_hash = ${sha256(token)}
      from locations as location
      where ticket.tenant_id = ${context.tenantId} and ticket.id = ${ticketId}
        ${andLocation(context, sql`ticket.location_id`)}
        and location.tenant_id = ticket.tenant_id and location.id = ticket.location_id
        and ticket.day = (now() at time zone location.timezone)::date
      returning ticket.id, ticket.appointment_id, ticket.number
    `);
    if (!row) throw new ApiError(404, "ticket_not_found", "That token is no longer in today's queue.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff",
      action: "queue.phone_link_made", outcome: "success", appointmentId: row.appointment_id,
      metadata: { ticketId: row.id, number: Number(row.number) },
    });
  });
  return { path: `${TICKET_ROUTE_PATH}${token}` };
}

// ── Public: reading by secret link ──────────────────────────────────────

async function resolve(fn: "display" | "ticket", token: string): Promise<{ tenantId: string; id: string }> {
  const parsed = queueTokenSchema.safeParse(token);
  const database = getDatabase();
  if (!parsed.success || !database || isPreviewMode()) throw notFound();
  const rows = fn === "display"
    ? await database.execute<{ tenant_id: string; location_id: string }>(sql`select * from kalendr_resolve_queue_display(${sha256(parsed.data)})`)
    : await database.execute<{ tenant_id: string; ticket_id: string }>(sql`select * from kalendr_resolve_queue_ticket(${sha256(parsed.data)})`);
  const row = rows[0] as Record<string, string> | undefined;
  if (!row) throw notFound();
  return { tenantId: row.tenant_id!, id: (row.location_id ?? row.ticket_id)! };
}

async function place(transaction: KalendrTransaction, tenantId: string, locationId: string) {
  const [row] = await transaction.execute<{ business: string; location: string }>(sql`
    select tenant.name as business, location.name as location
    from locations as location join tenants as tenant on tenant.id = location.tenant_id
    where location.tenant_id = ${tenantId} and location.id = ${locationId}
  `);
  if (!row) throw notFound();
  return { businessName: row.business, locationName: row.location };
}

/** Today's waiting tokens at a location, in call order. */
async function waitingTickets(transaction: KalendrTransaction, tenantId: string, locationId: string) {
  return transaction.execute<{ id: string; number: number; practitioner_id: string }>(sql`
    select ticket.id, ticket.number, appointment.practitioner_id
    from queue_tickets as ticket
    join appointments as appointment
      on appointment.tenant_id = ticket.tenant_id and appointment.id = ticket.appointment_id
    join locations as location
      on location.tenant_id = ticket.tenant_id and location.id = ticket.location_id
    where ticket.tenant_id = ${tenantId} and ticket.location_id = ${locationId}
      and ticket.day = (now() at time zone location.timezone)::date
      and ticket.called_at is null
      and appointment.status = 'checked_in'
      and appointment.visit_started_at is null
    order by ${waitingOrder}
  `);
}

/** What the waiting-room screen shows. */
export async function getQueueScreen(token: string): Promise<QueueScreen> {
  const resolved = await resolve("display", token);
  return withTenant(resolved.tenantId, async (transaction) => {
    const where = await place(transaction, resolved.tenantId, resolved.id);
    const calling = await transaction.execute<{ number: number; to: string; called_at: Date | string }>(sql`
      select ticket.number, practitioner.name as to, ticket.called_at
      from queue_tickets as ticket
      join appointments as appointment
        on appointment.tenant_id = ticket.tenant_id and appointment.id = ticket.appointment_id
      join practitioners as practitioner
        on practitioner.tenant_id = appointment.tenant_id and practitioner.id = appointment.practitioner_id
      join locations as location
        on location.tenant_id = ticket.tenant_id and location.id = ticket.location_id
      where ticket.tenant_id = ${resolved.tenantId} and ticket.location_id = ${resolved.id}
        and ticket.day = (now() at time zone location.timezone)::date
        and ticket.called_at is not null
        and appointment.status = 'checked_in'
        and appointment.visit_started_at is null
      order by ticket.called_at desc
      limit 4
    `);
    const waiting = await waitingTickets(transaction, resolved.tenantId, resolved.id);
    return {
      ...where,
      calling: calling.map((row) => ({ number: Number(row.number), to: row.to, calledAt: new Date(row.called_at).toISOString() })),
      next: waiting.slice(0, 10).map((row) => Number(row.number)),
      waitingCount: waiting.length,
      at: new Date().toISOString(),
    };
  });
}

/**
 * A rough wait: people ahead times a recent visit length, shared across the people seeing
 * customers today, shown as a range because visits vary.
 */
export function waitRange(ahead: number, visitMinutes: number, seeing: number): { low: number; high: number } | null {
  if (ahead <= 0) return null;
  const minutes = (ahead * Math.max(1, visitMinutes)) / Math.max(1, seeing);
  const low = Math.max(0, Math.floor((minutes * 0.75) / 5) * 5);
  const high = Math.max(5, Math.ceil((minutes * 1.25) / 5) * 5);
  return { low, high: Math.max(high, low + 5) };
}

async function ticketStatus(transaction: KalendrTransaction, tenantId: string, ticketId: string): Promise<QueueTicketStatus> {
  const [ticket] = await transaction.execute<{
    location_id: string; number: number; called_at: Date | string | null; status: string; visit_started_at: Date | string | null;
    notify_when_next: boolean; next_notified_at: Date | string | null; practitioner: string; has_phone: boolean;
  }>(sql`
    select ticket.location_id, ticket.number, ticket.called_at, appointment.status::text as status, appointment.visit_started_at,
      ticket.notify_when_next, ticket.next_notified_at, practitioner.name as practitioner,
      (length(trim(patient.phone)) > 0) as has_phone
    from queue_tickets as ticket
    join appointments as appointment
      on appointment.tenant_id = ticket.tenant_id and appointment.id = ticket.appointment_id
    join practitioners as practitioner
      on practitioner.tenant_id = appointment.tenant_id and practitioner.id = appointment.practitioner_id
    join patients as patient
      on patient.tenant_id = appointment.tenant_id and patient.id = appointment.patient_id
    where ticket.tenant_id = ${tenantId} and ticket.id = ${ticketId}
  `);
  if (!ticket) throw notFound();
  const where = await place(transaction, tenantId, ticket.location_id);
  const state: QueueTicketState = ticket.status === "completed" ? "done"
    : ticket.status !== "checked_in" ? "left"
    : ticket.visit_started_at ? "with"
    : ticket.called_at ? "called"
    : "waiting";
  let ahead = 0;
  let wait: QueueTicketStatus["wait"] = null;
  if (state === "waiting") {
    const waiting = await waitingTickets(transaction, tenantId, ticket.location_id);
    ahead = Math.max(0, waiting.findIndex((row) => row.id === ticketId));
    const [pace] = await transaction.execute<{ visit_seconds: number | string | null; seeing: number | string }>(sql`
      select
        (select avg(extract(epoch from completed_at - visit_started_at))
           from appointments
           where tenant_id = ${tenantId} and location_id = ${ticket.location_id} and status = 'completed'
             and completed_at > visit_started_at and completed_at > now() - interval '14 days') as visit_seconds,
        (select count(distinct practitioner_id)
           from appointments
           where tenant_id = ${tenantId} and location_id = ${ticket.location_id}
             and status in ('checked_in', 'completed') and checked_in_at > now() - interval '12 hours') as seeing
    `);
    const visitMinutes = pace?.visit_seconds ? Number(pace.visit_seconds) / 60 : DEFAULT_VISIT_MINUTES;
    wait = waitRange(ahead, visitMinutes, Number(pace?.seeing ?? 1));
  }
  return {
    ...where,
    number: Number(ticket.number),
    state,
    ahead,
    wait,
    calledTo: state === "called" || state === "with" ? ticket.practitioner : null,
    notifyWhenNext: ticket.notify_when_next,
    notified: Boolean(ticket.next_notified_at),
    canNotify: ticket.has_phone,
    at: new Date().toISOString(),
  };
}

/** The customer's own view of their place in the queue. */
export async function getQueueTicket(token: string): Promise<QueueTicketStatus> {
  const resolved = await resolve("ticket", token);
  return withTenant(resolved.tenantId, (transaction) => ticketStatus(transaction, resolved.tenantId, resolved.id));
}

/**
 * The customer turns "Tell me when I'm next" on or off. Turning it on when they are already
 * close sends the message straight away. Only a yes or no is taken, so the link can't be used
 * to send anything else.
 */
export async function setTicketNotify(token: string, input: z.infer<typeof ticketNotifyInputSchema>): Promise<QueueTicketStatus> {
  const resolved = await resolve("ticket", token);
  return withTenant(resolved.tenantId, async (transaction) => {
    const [row] = await transaction.execute<{ location_id: string; appointment_id: string; changed: boolean }>(sql`
      update queue_tickets set notify_when_next = ${input.notifyWhenNext}
      where tenant_id = ${resolved.tenantId} and id = ${resolved.id}
      returning location_id, appointment_id
    `);
    if (!row) throw notFound();
    await transaction.insert(auditEvents).values({
      tenantId: resolved.tenantId, actorType: "patient", action: input.notifyWhenNext ? "queue.notify_on" : "queue.notify_off",
      outcome: "success", appointmentId: row.appointment_id, metadata: { ticketId: resolved.id },
    });
    if (input.notifyWhenNext) await sendAlmostNext(transaction, resolved.tenantId, row.location_id);
    return ticketStatus(transaction, resolved.tenantId, resolved.id);
  });
}

export { ALMOST_NEXT_AHEAD };
