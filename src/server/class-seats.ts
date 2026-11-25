/**
 * The seat rules for a class session (feature 18), written against `Runner` so the web server's transaction and the
 * worker's run the same code. No "server-only": the worker imports it.
 *
 * Safety comes from three layers. Every change to a session's seats first locks the session row (`for update`), so two
 * people reaching for the last seat queue one behind the other. The count is read after the lock, so the second sees
 * the first's seat. And a database trigger refuses any write that would hold more seats than the session has, in case
 * a future code path forgets the lock.
 */
import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { CLASS_NOTICE_EVENT, CLASS_OFFER_EXPIRE_EVENT, CLASS_OFFER_MINUTES, CLASS_OFFER_MIN_LEAD_MINUTES } from "@/lib/classes-contracts";

import { asDate, asNumber, asString, type Row, type Runner } from "./workflows/runner";

/** Ties a sealed seat link to this use, so it can never be opened as a manage link. */
export const SEAT_SEAL_PURPOSE = "class_seat";

export interface SessionRow {
  id: string;
  serviceId: string;
  practitionerId: string;
  locationId: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  status: string;
  version: number;
}

function toSession(row: Row): SessionRow {
  return {
    id: asString(row.id), serviceId: asString(row.service_id), practitionerId: asString(row.practitioner_id), locationId: asString(row.location_id),
    startsAt: asDate(row.starts_at), endsAt: asDate(row.ends_at), capacity: asNumber(row.capacity), status: asString(row.status), version: asNumber(row.version),
  };
}

/** Locks one session. Every seat change starts here. */
export async function lockSession(run: Runner, tenantId: string, sessionId: string): Promise<SessionRow | null> {
  const [row] = await run(sql`
    select id, service_id, practitioner_id, location_id, starts_at, ends_at, capacity, status, version
    from class_sessions where tenant_id = ${tenantId} and id = ${sessionId} for update
  `);
  return row ? toSession(row) : null;
}

/** Seats in use: booked, attended and no-show people, and waiting people holding a live offer. */
export async function seatsHeld(run: Runner, tenantId: string, sessionId: string, exceptEnrolmentId?: string): Promise<number> {
  const [row] = await run(sql`
    select count(*) as held from class_enrolments
    where tenant_id = ${tenantId} and session_id = ${sessionId}
      and (status in ('booked', 'attended', 'no_show') or (status = 'waitlisted' and offer_expires_at is not null and offer_expires_at > now()))
      ${exceptEnrolmentId ? sql`and id <> ${exceptEnrolmentId}` : sql``}
  `);
  return asNumber(row?.held);
}

/** Where a waiting person stands, counting from 1. */
export async function waitPosition(run: Runner, tenantId: string, sessionId: string, enrolmentId: string): Promise<number> {
  const [row] = await run(sql`
    select count(*) as ahead from class_enrolments as other
    join class_enrolments as me on me.tenant_id = other.tenant_id and me.id = ${enrolmentId}
    where other.tenant_id = ${tenantId} and other.session_id = ${sessionId} and other.status = 'waitlisted'
      and (other.created_at, other.id) < (me.created_at, me.id)
  `);
  return asNumber(row?.ahead) + 1;
}

export type NoticeKind = "enrolled" | "waitlisted" | "offer" | "session_cancelled" | "broadcast";

/** Queues one message about one enrolment. The text for a broadcast goes in the payload for the worker only, never the audit trail. */
export async function queueNotice(
  run: Runner,
  tenantId: string,
  enrolmentId: string,
  kind: NoticeKind,
  options: { nonce: string; message?: string; minutes?: number },
): Promise<void> {
  const payload = { enrolmentId, kind, ...(options.message ? { message: options.message } : {}), ...(options.minutes ? { minutes: options.minutes } : {}) };
  await run(sql`
    insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
    values (${tenantId}, 'class_enrolment', ${enrolmentId}, ${CLASS_NOTICE_EVENT}, ${JSON.stringify(payload)}::text::jsonb,
      ${`${CLASS_NOTICE_EVENT}:${kind}:${enrolmentId}:${createHash("sha256").update(options.nonce).digest("hex").slice(0, 24)}`})
    on conflict (tenant_id, dedupe_key) do nothing
  `);
}

/**
 * Gives free seats to the people waiting, first come first served, each with a timed hold. The session must already be
 * locked. A seat is not offered when the class is about to start (the answer time would run past it); it then stays free
 * for anyone to take. Returns how many offers were made.
 */
export async function offerFreeSeats(run: Runner, tenantId: string, session: SessionRow, now: Date): Promise<number> {
  if (session.status !== "scheduled") return 0;
  if (session.startsAt.getTime() - now.getTime() < CLASS_OFFER_MIN_LEAD_MINUTES * 60_000) return 0;
  const free = session.capacity - await seatsHeld(run, tenantId, session.id);
  if (free <= 0) return 0;
  // Never ask for an answer after the class has started; the last minutes before it are given back to open booking.
  const answerBy = new Date(Math.min(now.getTime() + CLASS_OFFER_MINUTES * 60_000, session.startsAt.getTime() - 5 * 60_000));
  const waiting = await run(sql`
    select id from class_enrolments
    where tenant_id = ${tenantId} and session_id = ${session.id} and status = 'waitlisted' and offer_expires_at is null and offer_passed_at is null
    order by created_at, id
    limit ${free}
  `);
  for (const entry of waiting) {
    const id = asString(entry.id);
    await run(sql`
      update class_enrolments set offer_expires_at = ${answerBy.toISOString()}::timestamptz, offered_at = ${now.toISOString()}::timestamptz,
        version = version + 1, updated_at = now()
      where tenant_id = ${tenantId} and id = ${id}
    `);
    await queueNotice(run, tenantId, id, "offer", { nonce: answerBy.toISOString(), minutes: Math.max(1, Math.round((answerBy.getTime() - now.getTime()) / 60_000)) });
    await run(sql`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key, available_at)
      values (${tenantId}, 'class_enrolment', ${id}, ${CLASS_OFFER_EXPIRE_EVENT}, ${JSON.stringify({ enrolmentId: id })}::text::jsonb,
        ${`${CLASS_OFFER_EXPIRE_EVENT}:${id}:${answerBy.getTime()}`}, ${answerBy.toISOString()}::timestamptz)
      on conflict (tenant_id, dedupe_key) do nothing
    `);
    await run(sql`
      insert into audit_events (tenant_id, actor_type, action, outcome, metadata)
      values (${tenantId}, 'system', 'class.seat.offered', 'success', ${JSON.stringify({ sessionId: session.id, enrolmentId: id })}::text::jsonb)
    `);
  }
  return waiting.length;
}

/** An offer that was not taken in time, or was turned down: the person keeps their place in history but is passed over, and the seat goes to the next. */
export async function passOffer(run: Runner, tenantId: string, enrolmentId: string, now: Date, why: "expired" | "declined"): Promise<boolean> {
  const [found] = await run(sql`select session_id from class_enrolments where tenant_id = ${tenantId} and id = ${enrolmentId}`);
  if (!found) return false;
  const session = await lockSession(run, tenantId, asString(found.session_id));
  if (!session) return false;
  const changed = await run(sql`
    update class_enrolments set offer_expires_at = null, offer_passed_at = ${now.toISOString()}::timestamptz, version = version + 1, updated_at = now()
    where tenant_id = ${tenantId} and id = ${enrolmentId} and status = 'waitlisted' and offer_expires_at is not null
    returning id
  `);
  if (changed.length === 0) return false;
  await run(sql`
    insert into audit_events (tenant_id, actor_type, action, outcome, metadata)
    values (${tenantId}, 'system', ${`class.seat.offer_${why}`}, 'success', ${JSON.stringify({ sessionId: session.id, enrolmentId })}::text::jsonb)
  `);
  await offerFreeSeats(run, tenantId, session, now);
  return true;
}
