/**
 * Decides, inside the booking transaction, whether a video room should be made or closed for a booking. It only
 * writes outbox rows: the worker makes the room 15 minutes before the start, and a booking that is cancelled or
 * moved first never gets one. No "server-only": engine.ts calls it from both the web app and the worker.
 */
import { sql } from "drizzle-orm";

import { VISIT_OPENS_BEFORE_MINUTES } from "@/lib/video-contracts";

import { asDate, asString, type Runner } from "../workflows/runner";

export const VIDEO_ROOM_EVENT = "video.room";
export const VIDEO_ROOM_END_EVENT = "video.room.end";

export async function planVideoRoom(run: Runner, tenantId: string, appointmentId: string, now: Date = new Date()): Promise<void> {
  const [appointment] = await run(sql`
    select status, delivery_mode, starts_at, ends_at, version from appointments
    where tenant_id = ${tenantId} and id = ${appointmentId}
  `);
  if (!appointment) return;
  const startsAt = asDate(appointment.starts_at);
  const live = ["requested", "booked", "checked_in"].includes(asString(appointment.status));
  if (asString(appointment.delivery_mode) === "video" && live && asDate(appointment.ends_at) > now) {
    const makeAt = new Date(Math.max(now.getTime(), startsAt.getTime() - VISIT_OPENS_BEFORE_MINUTES * 60_000));
    await run(sql`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key, available_at)
      values (${tenantId}, 'appointment', ${appointmentId}, ${VIDEO_ROOM_EVENT},
        jsonb_build_object('appointmentId', ${appointmentId}::text, 'startsAt', ${startsAt.toISOString()}::text),
        ${`${VIDEO_ROOM_EVENT}:${appointmentId}:v${asString(appointment.version)}`}, ${makeAt.toISOString()}::timestamptz)
      on conflict (tenant_id, dedupe_key) do nothing
    `);
    return;
  }
  // Cancelled, or no longer a video visit: close a room that was already made.
  const [room] = await run(sql`select 1 as present from video_rooms where tenant_id = ${tenantId} and appointment_id = ${appointmentId} and status = 'active'`);
  if (room && !live) {
    await run(sql`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
      values (${tenantId}, 'appointment', ${appointmentId}, ${VIDEO_ROOM_END_EVENT},
        jsonb_build_object('appointmentId', ${appointmentId}::text), ${`${VIDEO_ROOM_END_EVENT}:${appointmentId}`})
      on conflict (tenant_id, dedupe_key) do nothing
    `);
  }
}
