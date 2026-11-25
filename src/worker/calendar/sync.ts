/**
 * `calendar.sync`: read one calendar's changes and keep two things true.
 *  1. external_busy holds only start, end and event id for the calendars a person ticked, so the
 *     booking page never offers a time they are busy. Events Kalendr wrote itself are skipped.
 *  2. A linked event moved or deleted outside Kalendr raises one "needs a person" item. The
 *     appointment itself is never changed here.
 * The selection row is locked first, so two syncs at once take turns and the second one reads the
 * token the first saved.
 */
import { z } from "zod";

import { classifyExternalChange, planBusy } from "../../server/calendars/logic";
import type { BusyEvent, SyncResult } from "../../server/calendars/provider";
import type { EventHandler, TenantDb } from "../handlers/types";
import { ensureChannel, type SelectionChannelRow } from "./channel";
import { alertMember, liveCalendarDeps, loadKeys, markNeedsReconnect, openSession, readConnection, readWindow, type CalendarDeps, type ConnectionRow } from "./common";

const payloadSchema = z.object({
  selectionId: z.string().min(1),
  /** Throw the saved position away and read the whole window again. */
  resnapshot: z.boolean().optional(),
});

interface SelectionRow extends SelectionChannelRow {
  connection_id: string;
  membership_id: string;
  blocks_availability: boolean;
  writes_here: boolean;
  sync_token: string | null;
}

interface LinkRow {
  link_id: string;
  event_id: string;
  link_status: "active" | "deleted";
  pushed_starts_at: Date;
  pushed_ends_at: Date;
  appointment_id: string;
  appointment_status: string;
  appointment_starts_at: Date;
  appointment_ends_at: Date;
  write_pending: boolean;
}

export function calendarSyncHandler(deps: CalendarDeps = liveCalendarDeps): EventHandler {
  return async (tenantDb, event) => {
    const parsed = payloadSchema.safeParse(event.payload);
    if (!parsed.success) return { outcome: "dead", code: "invalid_calendar_event" };
    const { tenantId } = event;
    await loadKeys(tenantDb, tenantId);

    const [selection] = await tenantDb<SelectionRow[]>`
      select id, connection_id, membership_id, calendar_id, blocks_availability, writes_here, sync_token,
        channel_id, channel_resource_id, channel_expires_at
      from calendar_selections where tenant_id = ${tenantId} and id = ${parsed.data.selectionId} for update`;
    if (!selection || !(selection.blocks_availability || selection.writes_here)) return "delivered";
    const connection = await readConnection(tenantDb, tenantId, selection.connection_id);
    if (!connection || connection.status !== "active") return "delivered";

    const session = openSession(tenantDb, tenantId, connection, deps);
    if (!session) {
      await markNeedsReconnect(tenantDb, tenantId, connection);
      return "delivered";
    }

    const now = deps.now();
    const window = await readWindow(tenantDb, tenantId, now);
    const readFrom = (syncToken: string | null) => session.call((provider, credentials) =>
      provider.syncChanges(credentials, selection.calendar_id, { syncToken, from: window.from, to: window.to }));

    let read = await readFrom(parsed.data.resnapshot ? null : selection.sync_token);
    if (read.ok && read.value.fullResyncRequired) read = await readFrom(null);
    if (!read.ok) {
      await session.persist();
      if (read.failure.kind === "revoked") {
        await markNeedsReconnect(tenantDb, tenantId, connection);
        return "delivered";
      }
      if (read.failure.kind === "provider_error" && read.failure.code === "not_found") {
        // The calendar was deleted on the provider's side: stop reading it rather than retrying forever.
        await tenantDb`
          update calendar_selections set blocks_availability = false, writes_here = false, version = version + 1, updated_at = now()
          where tenant_id = ${tenantId} and id = ${selection.id}`;
        await tenantDb`delete from external_busy where tenant_id = ${tenantId} and selection_id = ${selection.id}`;
        return "delivered";
      }
      return read.outcome;
    }
    const result: SyncResult = read.value;
    if (result.fullResyncRequired) return { outcome: "retry", code: "resync_failed" };

    await applyRead(tenantDb, tenantId, connection, selection, result.mode, result.events, window, now);
    await tenantDb`
      update calendar_selections set sync_token = ${result.nextSyncToken}, last_synced_at = ${now},
        last_snapshot_at = case when ${result.mode === "snapshot"} then ${now}::timestamptz else last_snapshot_at end, updated_at = now()
      where tenant_id = ${tenantId} and id = ${selection.id}`;
    await ensureChannel(tenantDb, tenantId, session, connection, selection, now);
    await session.persist();
    return "delivered";
  };
}

async function applyRead(
  tenantDb: TenantDb,
  tenantId: string,
  connection: ConnectionRow,
  selection: SelectionRow,
  mode: "snapshot" | "delta",
  events: BusyEvent[],
  window: { from: Date; to: Date },
  now: Date,
): Promise<void> {
  const links = await tenantDb<LinkRow[]>`
    select link.id as link_id, link.event_id, link.status as link_status, link.pushed_starts_at, link.pushed_ends_at,
      appointment.id as appointment_id, appointment.status as appointment_status,
      appointment.starts_at as appointment_starts_at, appointment.ends_at as appointment_ends_at,
      exists (
        select 1 from outbox_events as pending
        where pending.tenant_id = link.tenant_id and pending.aggregate_id = link.appointment_id
          and pending.event_type = 'calendar.write' and pending.status in ('pending', 'failed', 'processing')
      ) as write_pending
    from appointment_event_links as link
    join appointments as appointment on appointment.tenant_id = link.tenant_id and appointment.id = link.appointment_id
    where link.tenant_id = ${tenantId} and link.selection_id = ${selection.id}`;
  const byEvent = new Map(links.map((link) => [link.event_id, link]));

  if (selection.blocks_availability) {
    const cached = mode === "snapshot"
      ? (await tenantDb<{ source_event_id: string }[]>`select source_event_id from external_busy where tenant_id = ${tenantId} and selection_id = ${selection.id}`).map((row) => row.source_event_id)
      : [];
    const plan = planBusy(mode, events, new Set(byEvent.keys()), cached);
    if (plan.remove.length) {
      await tenantDb`
        delete from external_busy where tenant_id = ${tenantId} and selection_id = ${selection.id}
          and source_event_id = any(${plan.remove}::text[])`;
    }
    if (plan.upsert.length) {
      await tenantDb`
        insert into external_busy (tenant_id, membership_id, selection_id, source_event_id, starts_at, ends_at)
        select ${tenantId}, ${selection.membership_id}, ${selection.id}, item.id, item.starts_at, item.ends_at
        from unnest(${plan.upsert.map((row) => row.sourceEventId)}::text[], ${plan.upsert.map((row) => row.startsAt.toISOString())}::timestamptz[],
          ${plan.upsert.map((row) => row.endsAt.toISOString())}::timestamptz[]) as item(id, starts_at, ends_at)
        on conflict (tenant_id, selection_id, source_event_id) do update
          set starts_at = excluded.starts_at, ends_at = excluded.ends_at`;
    }
  }

  const seen = new Set<string>();
  for (const event of events) {
    seen.add(event.sourceEventId);
    const link = byEvent.get(event.sourceEventId);
    if (link) await judge(tenantDb, tenantId, selection, link, event);
  }
  if (mode === "snapshot") {
    // A snapshot lists every event in the window, so a linked event inside it that is missing was deleted.
    const gone: BusyEvent = { sourceEventId: "", cancelled: true, startsAt: null, endsAt: null };
    for (const link of links) {
      if (seen.has(link.event_id)) continue;
      const inWindow = link.pushed_ends_at.getTime() > Math.max(window.from.getTime(), now.getTime()) && link.pushed_starts_at.getTime() < window.to.getTime();
      if (inWindow) await judge(tenantDb, tenantId, selection, link, { ...gone, sourceEventId: link.event_id });
    }
  }
}

interface ConflictSource {
  id: string;
  membership_id: string;
}

async function judge(tenantDb: TenantDb, tenantId: string, selection: SelectionRow, link: LinkRow, event: BusyEvent): Promise<void> {
  const change = classifyExternalChange(
    { status: link.link_status, pushedStartsAt: link.pushed_starts_at, pushedEndsAt: link.pushed_ends_at },
    event,
    { status: link.appointment_status, startsAt: link.appointment_starts_at, endsAt: link.appointment_ends_at },
    link.write_pending,
  );
  if (change.kind === "in_place") {
    await tenantDb`
      update calendar_conflicts set status = 'obsolete', resolved_at = now()
      where tenant_id = ${tenantId} and appointment_id = ${link.appointment_id} and selection_id = ${selection.id} and status = 'open'`;
    return;
  }
  if (change.kind !== "moved" && change.kind !== "deleted") return;
  await raiseConflict(tenantDb, tenantId, selection, link, change.kind, change.kind === "moved" ? change.eventStartsAt : null, change.kind === "moved" ? change.eventEndsAt : null);
}

/** Records one open "needs a person" item per appointment and calendar, and tells the calendar's owner once. */
async function raiseConflict(
  tenantDb: TenantDb,
  tenantId: string,
  selection: ConflictSource,
  link: Pick<LinkRow, "appointment_id" | "appointment_starts_at" | "appointment_ends_at">,
  kind: "moved" | "deleted",
  eventStarts: Date | null,
  eventEnds: Date | null,
): Promise<void> {
  const inserted = await tenantDb`
    insert into calendar_conflicts (tenant_id, appointment_id, selection_id, membership_id, kind,
      appointment_starts_at, appointment_ends_at, event_starts_at, event_ends_at)
    values (${tenantId}, ${link.appointment_id}, ${selection.id}, ${selection.membership_id}, ${kind},
      ${link.appointment_starts_at}, ${link.appointment_ends_at}, ${eventStarts}, ${eventEnds})
    on conflict (tenant_id, appointment_id, selection_id) where status = 'open' do nothing
    returning id`;
  const created = inserted[0];
  if (created) {
    await alertMember(
      tenantDb, tenantId, selection.membership_id,
      kind === "moved" ? "A booking was moved in your calendar" : "A booking was deleted from your calendar",
      "/profile", `calendar.conflict:${created.id}`,
    );
  }
}
