import "server-only";

import { sql } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import { outboxEvents } from "@/db/schema";
import { QUICK_MESSAGE_EVENT } from "@/lib/quick-messages";

import { currentTraceParent } from "./tracing";

/**
 * The order waiting customers are called in, for queries that join `queue_tickets as ticket`
 * and `appointments as appointment`. Call next, the wall screen and the customer's own page all use it.
 */
export const waitingOrder = sql`ticket.urgent desc,
  (ticket.skipped_at is not null),
  (appointment.booking_source <> 'walk_in' and appointment.starts_at <= now()) desc,
  ticket.number`;

/** A customer who asked is told when this many people or fewer are ahead of them. */
export const ALMOST_NEXT_AHEAD = 2;

/**
 * Queues "You're almost next" for customers who asked for it and now have two or fewer people
 * ahead. Each ticket is told once: the outbox row is keyed by ticket. Nothing is sent here; the
 * worker delivers it. Call inside the transaction that moved the queue.
 */
export async function sendAlmostNext(transaction: KalendrTransaction, tenantId: string, locationId: string): Promise<number> {
  const due = await transaction.execute<{ id: string; appointment_id: string; version: number }>(sql`
    select id, appointment_id, version from (
      select ticket.id, ticket.appointment_id, appointment.version, ticket.notify_when_next, ticket.next_notified_at,
        row_number() over (order by ${waitingOrder}) - 1 as ahead
      from queue_tickets as ticket
      join appointments as appointment
        on appointment.tenant_id = ticket.tenant_id and appointment.id = ticket.appointment_id
      join locations as location
        on location.tenant_id = ticket.tenant_id and location.id = ticket.location_id
      where ticket.tenant_id = ${tenantId}
        and ticket.location_id = ${locationId}
        and ticket.day = (now() at time zone location.timezone)::date
        and ticket.called_at is null
        and appointment.status = 'checked_in'
        and appointment.visit_started_at is null
    ) as waiting
    where notify_when_next and next_notified_at is null and ahead <= ${ALMOST_NEXT_AHEAD}
  `);
  for (const row of due) {
    await transaction.insert(outboxEvents).values({
      tenantId,
      aggregateType: "appointment",
      aggregateId: row.appointment_id,
      eventType: QUICK_MESSAGE_EVENT,
      payload: { appointmentId: row.appointment_id, version: Number(row.version), kind: "almost_next" },
      dedupeKey: `almost_next:${row.id}`,
      traceParent: currentTraceParent(),
    }).onConflictDoNothing();
    await transaction.execute(sql`
      update queue_tickets set next_notified_at = now() where tenant_id = ${tenantId} and id = ${row.id}
    `);
  }
  return due.length;
}
