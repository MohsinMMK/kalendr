import { z } from "zod";

import { roomExpiry, roomNameFor } from "../../server/video/rules";
import { VideoPermanentError, VideoTransientError } from "../../server/video/provider";
import type { HandlerDependencies } from "./appointment-message";
import type { EventHandler, HandlerOutcome } from "./types";

/**
 * Makes the call room for a video visit (`video.room`, queued to run 15 minutes before the start) and closes it when
 * the booking is cancelled (`video.room.end`). Both re-read the booking first, so a visit that was cancelled or moved
 * after the event was queued gets no room. Nothing is logged: not a name, a link or a token.
 */
const payload = z.object({ appointmentId: z.string().min(1), startsAt: z.string().optional() });

interface AppointmentRow {
  status: string;
  delivery_mode: string;
  starts_at: Date;
  ends_at: Date;
}

interface RoomRow {
  id: string;
  provider_room_name: string;
  expires_at: Date;
  status: string;
}

export function videoRoomHandler({ video, now }: HandlerDependencies): EventHandler {
  return async (tenantDb, event): Promise<HandlerOutcome> => {
    const parsed = payload.safeParse(event.payload);
    if (!parsed.success) return { outcome: "dead", code: "invalid_payload" };
    const [appointment] = await tenantDb`
      select status, delivery_mode, starts_at, ends_at from appointments
      where tenant_id = ${event.tenantId} and id = ${parsed.data.appointmentId}
      for update
    ` as unknown as AppointmentRow[];
    // Cancelled, no longer video, over already, or moved since this event was queued (the move queued its own): no room.
    if (!appointment || appointment.delivery_mode !== "video" || !["requested", "booked", "checked_in"].includes(appointment.status)) return "delivered";
    if (appointment.ends_at <= now()) return "delivered";
    if (parsed.data.startsAt && new Date(parsed.data.startsAt).getTime() !== appointment.starts_at.getTime()) return "delivered";
    if (!video) return { outcome: "dead", code: "provider_not_configured" };

    const name = roomNameFor(event.tenantId, parsed.data.appointmentId);
    const expiresAt = roomExpiry(appointment.ends_at);
    const [existing] = await tenantDb`
      select id, provider_room_name, expires_at, status from video_rooms
      where tenant_id = ${event.tenantId} and appointment_id = ${parsed.data.appointmentId}
    ` as unknown as RoomRow[];
    if (existing && existing.status === "active" && existing.expires_at.getTime() === expiresAt.getTime()) return "delivered";
    try {
      // The booking moved after its room was made: close the old room and make one for the new time.
      if (existing) await video.deleteRoom(existing.provider_room_name);
      const room = await video.createRoom({ name, expiresAt });
      await tenantDb`
        insert into video_rooms (tenant_id, appointment_id, provider, provider_room_name, room_url, expires_at)
        values (${event.tenantId}, ${parsed.data.appointmentId}, ${video.name}, ${room.name}, ${room.url}, ${expiresAt})
        on conflict (tenant_id, appointment_id) do update
          set provider = excluded.provider, provider_room_name = excluded.provider_room_name, room_url = excluded.room_url,
            expires_at = excluded.expires_at, status = 'active', customer_admitted_at = null, customer_waiting_at = null, updated_at = now()
      `;
      return "delivered";
    } catch (error) {
      if (error instanceof VideoTransientError) return { outcome: "retry", code: error.code };
      if (error instanceof VideoPermanentError) return { outcome: "dead", code: error.code };
      throw error;
    }
  };
}

export function videoRoomEndHandler({ video }: HandlerDependencies): EventHandler {
  return async (tenantDb, event): Promise<HandlerOutcome> => {
    const parsed = payload.safeParse(event.payload);
    if (!parsed.success) return { outcome: "dead", code: "invalid_payload" };
    const [appointment] = await tenantDb`
      select status from appointments where tenant_id = ${event.tenantId} and id = ${parsed.data.appointmentId}
    ` as unknown as { status: string }[];
    // Brought back to life since: leave the room alone.
    if (appointment && ["requested", "booked", "checked_in"].includes(appointment.status)) return "delivered";
    const [room] = await tenantDb`
      select id, provider_room_name, expires_at, status from video_rooms
      where tenant_id = ${event.tenantId} and appointment_id = ${parsed.data.appointmentId} and status = 'active'
    ` as unknown as RoomRow[];
    if (!room) return "delivered";
    try {
      await video?.deleteRoom(room.provider_room_name);
      await tenantDb`update video_rooms set status = 'ended', updated_at = now() where tenant_id = ${event.tenantId} and id = ${room.id}`;
      return "delivered";
    } catch (error) {
      if (error instanceof VideoTransientError) return { outcome: "retry", code: error.code };
      if (error instanceof VideoPermanentError) return { outcome: "dead", code: error.code };
      throw error;
    }
  };
}
