import { CALENDAR_DISCONNECT_EVENT, CALENDAR_RENEW_EVENT, CALENDAR_SYNC_EVENT, CALENDAR_VERIFY_EVENT, CALENDAR_WRITE_EVENT } from "../../lib/calendar-sync";
import type { EventHandler } from "../handlers/types";
import { liveCalendarDeps, type CalendarDeps } from "./common";
import { calendarDisconnectHandler, calendarRenewHandler, calendarVerifyHandler } from "./lifecycle";
import { calendarSyncHandler } from "./sync";
import { calendarWriteHandler } from "./write";

/** The calendar event types and their handlers (feature 16), for the worker's registry. */
export function calendarHandlers(deps: CalendarDeps = liveCalendarDeps): [string, EventHandler][] {
  return [
    [CALENDAR_SYNC_EVENT, calendarSyncHandler(deps)],
    [CALENDAR_WRITE_EVENT, calendarWriteHandler(deps)],
    [CALENDAR_RENEW_EVENT, calendarRenewHandler(deps)],
    [CALENDAR_VERIFY_EVENT, calendarVerifyHandler(deps)],
    [CALENDAR_DISCONNECT_EVENT, calendarDisconnectHandler(deps)],
  ];
}

/**
 * Wraps an appointment-change handler so the same event also queues a `calendar.write` for the appointment.
 * The queue row is separate, so a retry of the message never repeats the calendar write or the other way
 * round. It queues nothing unless the appointment's staff member writes to a calendar or an event already exists.
 */
export function withCalendarWrite(handler: EventHandler): EventHandler {
  return async (tenantDb, event) => {
    if (event.aggregateType === "appointment") {
      await tenantDb`
        insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
        select ${event.tenantId}, 'appointment', ${event.aggregateId}, ${CALENDAR_WRITE_EVENT},
          ${tenantDb.json({ appointmentId: event.aggregateId })}, ${`calendar.write:${event.aggregateId}:${event.dedupeKey}`.slice(0, 200)}
        where exists (
            select 1 from appointment_event_links as link
            where link.tenant_id = ${event.tenantId} and link.appointment_id = ${event.aggregateId}
          ) or exists (
            select 1 from appointments as appointment
            join practitioners as practitioner on practitioner.tenant_id = appointment.tenant_id and practitioner.id = appointment.practitioner_id
            join memberships as membership on membership.tenant_id = practitioner.tenant_id and membership.user_id = practitioner.auth_user_id
            join calendar_selections as selection on selection.tenant_id = membership.tenant_id and selection.membership_id = membership.id and selection.writes_here
            where appointment.tenant_id = ${event.tenantId} and appointment.id = ${event.aggregateId}
          )
        on conflict (tenant_id, dedupe_key) do nothing`;
    }
    return handler(tenantDb, event);
  };
}
