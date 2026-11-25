/**
 * `calendar.write`: make a staff member's calendar match an appointment. It does not replay what
 * happened; it compares the appointment as it is now with the event Kalendr last wrote and does
 * whatever is needed (create, update, delete, or nothing), so retries and out-of-order events are
 * harmless. The text follows the business's privacy setting and never holds a phone, email or notes.
 *
 * It also never overwrites a change made in the outside calendar: if the provider says the event
 * changed since Kalendr wrote it, it leaves the event alone and asks for a sync, which raises the
 * "needs a person" item.
 */
import { z } from "zod";

import { eventTextSchema, type EventTextSetting } from "../../lib/calendar-sync";
import { staffEntry } from "../../lib/event-wording";
import { loadWordingContext } from "../../server/calendar-wording";
import { appointmentEventShouldGo, appointmentNeedsEvent, eventContent, fieldsHash, type EventContent } from "../../server/calendars/logic";
import { appOrigin } from "../../server/env";
import { postgresRunner } from "../../server/workflows/runner";
import type { EventHandler, TenantDb } from "../handlers/types";
import { liveCalendarDeps, loadKeys, markNeedsReconnect, openSession, readConnection, type CalendarDeps, type ConnectionRow } from "./common";

const payloadSchema = z.object({
  appointmentId: z.string().min(1),
  /** "Put the calendar event back": write it even though the outside event was changed or deleted. */
  force: z.boolean().optional(),
});

interface AppointmentRow {
  id: string;
  version: number;
  status: string;
  starts_at: Date;
  ends_at: Date;
  first_name: string;
  last_name: string;
  service_name: string;
  location_name: string;
  location_timezone: string;
  membership_id: string | null;
}

interface TargetRow {
  id: string;
  connection_id: string;
  calendar_id: string;
}

interface LinkRow {
  id: string;
  selection_id: string;
  event_id: string;
  etag: string | null;
  fields_hash: string;
  status: "active" | "deleted";
}

/** The staff member behind an appointment's practitioner: the only link is the practitioner's sign-in. */
async function readAppointment(tenantDb: TenantDb, tenantId: string, appointmentId: string): Promise<AppointmentRow | undefined> {
  const rows = await tenantDb<AppointmentRow[]>`
    select appointment.id, appointment.version, appointment.status, appointment.starts_at, appointment.ends_at,
      patient.first_name, patient.last_name, service.name as service_name,
      location.name as location_name, location.timezone as location_timezone,
      (select membership.id from practitioners as practitioner
        join memberships as membership on membership.tenant_id = practitioner.tenant_id and membership.user_id = practitioner.auth_user_id and membership.is_active
        where practitioner.tenant_id = appointment.tenant_id and practitioner.id = appointment.practitioner_id) as membership_id
    from appointments as appointment
    join patients as patient on patient.tenant_id = appointment.tenant_id and patient.id = appointment.patient_id
    join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
    join locations as location on location.tenant_id = appointment.tenant_id and location.id = appointment.location_id
    where appointment.tenant_id = ${tenantId} and appointment.id = ${appointmentId}
    for update of appointment`;
  return rows[0];
}

async function readTarget(tenantDb: TenantDb, tenantId: string, membershipId: string | null): Promise<TargetRow | undefined> {
  if (!membershipId) return undefined;
  const rows = await tenantDb<TargetRow[]>`
    select selection.id, selection.connection_id, selection.calendar_id
    from calendar_selections as selection
    join calendar_connections as connection on connection.tenant_id = selection.tenant_id and connection.id = selection.connection_id
    where selection.tenant_id = ${tenantId} and selection.membership_id = ${membershipId}
      and selection.writes_here and selection.can_write and connection.status = 'active'`;
  return rows[0];
}

async function readSetting(tenantDb: TenantDb, tenantId: string): Promise<EventTextSetting> {
  const [row] = await tenantDb<{ event_text: string }[]>`select event_text from calendar_business_settings where tenant_id = ${tenantId}`;
  const parsed = eventTextSchema.safeParse(row?.event_text);
  return parsed.success ? parsed.data : "busy_only";
}

export function calendarWriteHandler(deps: CalendarDeps = liveCalendarDeps): EventHandler {
  return async (tenantDb, event) => {
    const parsed = payloadSchema.safeParse(event.payload);
    if (!parsed.success) return { outcome: "dead", code: "invalid_calendar_event" };
    const { tenantId } = event;
    const force = parsed.data.force === true;
    const appointment = await readAppointment(tenantDb, tenantId, parsed.data.appointmentId);
    if (!appointment) return "delivered";
    await loadKeys(tenantDb, tenantId);

    const target = await readTarget(tenantDb, tenantId, appointment.membership_id);
    const wanted = appointmentNeedsEvent(appointment.status) && target !== undefined;
    const links = await tenantDb<LinkRow[]>`
      select id, selection_id, event_id, etag, fields_hash, status from appointment_event_links
      where tenant_id = ${tenantId} and appointment_id = ${appointment.id} for update`;

    // A finished visit keeps its event as a record; only cancelled ones are taken out of calendars.
    if (!wanted && !appointmentEventShouldGo(appointment.status) && !(appointmentNeedsEvent(appointment.status) && links.length > 0)) return "delivered";

    // 1. An event in a calendar that is no longer where this appointment belongs (or no longer wanted) goes.
    for (const link of links) {
      if (link.status === "deleted" || (wanted && target && link.selection_id === target.id)) continue;
      const outcome = await removeEvent(tenantDb, tenantId, deps, link);
      if (outcome !== "done") return outcome;
    }
    if (!wanted || !target) return "delivered";

    // 2. The event in the chosen calendar.
    const connection = await readConnection(tenantDb, tenantId, target.connection_id);
    if (!connection || connection.status !== "active") return "delivered";
    const session = openSession(tenantDb, tenantId, connection, deps);
    if (!session) {
      await markNeedsReconnect(tenantDb, tenantId, connection);
      return "delivered";
    }
    const setting = await readSetting(tenantDb, tenantId);
    const usual = eventContent(setting, {
      firstName: appointment.first_name,
      lastName: appointment.last_name,
      serviceName: appointment.service_name,
      locationName: appointment.location_name,
      appointmentUrl: `${appOrigin()}/schedule?open=${encodeURIComponent(appointment.id)}`,
    });
    // The service's own wording (feature 50) is the more specific choice, so it wins over the business-wide setting when the
    // owner wrote a team title or asked for "Busy" only. "Hide details" writes only "Busy: business": no description, place or name.
    const wording = await loadWordingContext(postgresRunner(tenantDb), tenantId, appointment.id);
    const usesWording = wording !== null && (setting !== "busy_only" || wording.wording.hideDetails || Boolean(wording.wording.staffTitle?.trim()));
    const entry = wording && usesWording
      ? staffEntry(wording.wording, wording.values, { title: usual.title, description: usual.description ?? null, ...(usual.location ? { location: usual.location } : {}) }, wording.questionKeys)
      : null;
    const content: EventContent = entry
      ? { title: entry.title, ...(entry.description ? { description: entry.description } : {}), ...(entry.location ? { location: entry.location } : {}) }
      : usual;
    const hash = fieldsHash(content, appointment.starts_at, appointment.ends_at);
    const input = {
      title: content.title,
      ...(content.description ? { description: content.description } : {}),
      ...(content.location ? { location: content.location } : {}),
      start: appointment.starts_at.toISOString(),
      end: appointment.ends_at.toISOString(),
      timezone: appointment.location_timezone,
    };
    const current = links.find((link) => link.selection_id === target.id);

    let written: { eventId: string; etag: string | null } | undefined;
    if (!current || current.status === "deleted") {
      const key = current ? `kalendr:${appointment.id}:${target.id}:v${appointment.version}` : `kalendr:${appointment.id}:${target.id}`;
      const created = await session.call((provider, credentials) => provider.createEvent(credentials, target.calendar_id, { ...input, idempotencyKey: key }));
      await session.persist();
      if (!created.ok) return await failed(tenantDb, tenantId, connection, created);
      written = created.value;
    } else if (current.fields_hash === hash && !force) {
      return "delivered";
    } else {
      const updated = await session.call((provider, credentials) =>
        provider.updateEvent(credentials, target.calendar_id, current.event_id, input, force ? {} : { etag: current.etag }));
      await session.persist();
      if (!updated.ok) {
        const problem = updated.failure.kind === "provider_error" ? updated.failure.code : null;
        if (problem === "conflict" || problem === "not_found") {
          if (problem === "not_found" && force) {
            // "Put the calendar event back" after a delete: make a new event for the same appointment.
            const recreated = await session.call((provider, credentials) =>
              provider.createEvent(credentials, target.calendar_id, { ...input, idempotencyKey: `kalendr:${appointment.id}:${target.id}:v${appointment.version}:restore` }));
            await session.persist();
            if (!recreated.ok) return await failed(tenantDb, tenantId, connection, recreated);
            written = recreated.value;
          } else {
            await askForSync(tenantDb, tenantId, target.id, event.id);
            return "delivered";
          }
        } else {
          return await failed(tenantDb, tenantId, connection, updated);
        }
      } else {
        written = updated.value;
      }
    }
    if (!written) return "delivered";

    await tenantDb`
      insert into appointment_event_links (tenant_id, appointment_id, selection_id, event_id, etag, fields_hash, pushed_starts_at, pushed_ends_at, status)
      values (${tenantId}, ${appointment.id}, ${target.id}, ${written.eventId}, ${written.etag}, ${hash}, ${appointment.starts_at}, ${appointment.ends_at}, 'active')
      on conflict (tenant_id, appointment_id, selection_id) do update
        set event_id = excluded.event_id, etag = excluded.etag, fields_hash = excluded.fields_hash,
          pushed_starts_at = excluded.pushed_starts_at, pushed_ends_at = excluded.pushed_ends_at, status = 'active', updated_at = now()`;
    // A sync may have read our event before this link existed; drop the busy row it would have made.
    await tenantDb`delete from external_busy where tenant_id = ${tenantId} and selection_id = ${target.id} and source_event_id = ${written.eventId}`;
    await tenantDb`
      update calendar_conflicts set status = 'restored_event', resolved_at = now()
      where tenant_id = ${tenantId} and appointment_id = ${appointment.id} and selection_id = ${target.id} and status = 'open' and ${force}`;
    return "delivered";
  };
}

type Called = { ok: false; outcome: Awaited<ReturnType<EventHandler>>; failure: { kind: string } };

async function failed(tenantDb: TenantDb, tenantId: string, connection: ConnectionRow, result: Called) {
  if (result.failure.kind === "revoked") {
    await markNeedsReconnect(tenantDb, tenantId, connection);
    return "delivered" as const;
  }
  return result.outcome;
}

/**
 * Deletes the event Kalendr wrote in a calendar, then marks the link deleted so a later read does not call it a conflict.
 * While the calendar needs reconnecting the event is still there, so the link is kept and the delete is tried again on a
 * later change; the rest of the job (writing to the new calendar) still goes ahead. A calendar that was removed or is being
 * disconnected can no longer be written, so the link is let go.
 */
async function removeEvent(tenantDb: TenantDb, tenantId: string, deps: CalendarDeps, link: LinkRow): Promise<"done" | Awaited<ReturnType<EventHandler>>> {
  const [selection] = await tenantDb<{ connection_id: string; calendar_id: string }[]>`
    select connection_id, calendar_id from calendar_selections where tenant_id = ${tenantId} and id = ${link.selection_id}`;
  const connection = selection ? await readConnection(tenantDb, tenantId, selection.connection_id) : undefined;
  if (selection && connection && (connection.status === "needs_reconnect" || connection.status === "pending")) return "done";
  if (selection && connection && connection.status === "active") {
    const session = openSession(tenantDb, tenantId, connection, deps);
    if (!session) {
      await markNeedsReconnect(tenantDb, tenantId, connection);
      return "done";
    }
    const deleted = await session.call((provider, credentials) => provider.deleteEvent(credentials, selection.calendar_id, link.event_id));
    await session.persist();
    if (!deleted.ok) {
      const notFound = deleted.failure.kind === "provider_error" && deleted.failure.code === "not_found";
      if (deleted.failure.kind === "revoked") {
        await markNeedsReconnect(tenantDb, tenantId, connection);
        return "done";
      }
      if (!notFound) return deleted.outcome;
    }
  }
  await tenantDb`update appointment_event_links set status = 'deleted', updated_at = now() where tenant_id = ${tenantId} and id = ${link.id}`;
  return "done";
}

/** Reads the calendar again so a change made outside Kalendr is noticed (and raised) rather than overwritten. */
async function askForSync(tenantDb: TenantDb, tenantId: string, selectionId: string, eventId: string): Promise<void> {
  await tenantDb`
    insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
    values (${tenantId}, 'calendar_selection', ${selectionId}, 'calendar.sync', ${tenantDb.json({ selectionId })}, ${`calendar.sync:${selectionId}:changed:${eventId}`})
    on conflict (tenant_id, dedupe_key) do nothing`;
}
