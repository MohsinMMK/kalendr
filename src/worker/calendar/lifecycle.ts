/**
 * The life of a connection: `calendar.verify` checks a new login and lists its calendars,
 * `calendar.renew` keeps a calendar's watch channel alive, and `calendar.disconnect` stops the
 * channels and forgets the connection. Nothing here runs inside a web request.
 */
import { z } from "zod";

import type { CalendarInfo } from "../../server/calendars/provider";
import type { EventHandler } from "../handlers/types";
import { ensureChannel } from "./channel";
import { liveCalendarDeps, loadKeys, markNeedsReconnect, openSession, readConnection, type CalendarDeps } from "./common";

const connectionPayload = z.object({ connectionId: z.string().min(1) });
const selectionPayload = z.object({ selectionId: z.string().min(1) });

/** Checks a login the web app just saved (Google and Outlook after sign-in, Apple after the form) and lists its calendars. */
export function calendarVerifyHandler(deps: CalendarDeps = liveCalendarDeps): EventHandler {
  return async (tenantDb, event) => {
    const parsed = connectionPayload.safeParse(event.payload);
    if (!parsed.success) return { outcome: "dead", code: "invalid_calendar_event" };
    const { tenantId } = event;
    await loadKeys(tenantDb, tenantId);
    const connection = await readConnection(tenantDb, tenantId, parsed.data.connectionId);
    if (!connection || connection.status !== "pending") return "delivered";
    const session = openSession(tenantDb, tenantId, connection, deps);
    if (!session) {
      await markNeedsReconnect(tenantDb, tenantId, connection);
      return "delivered";
    }

    const account = await session.call((provider, credentials) => provider.verifyAccount(credentials));
    const calendars = account.ok ? await session.call((provider, credentials) => provider.listCalendars(credentials)) : null;
    await session.persist();
    const failed = !account.ok ? account : calendars && !calendars.ok ? calendars : null;
    if (failed) {
      if (failed.failure.kind === "revoked" || (failed.failure.kind === "provider_error" && failed.failure.code !== "not_found")) {
        // Wrong password or refused login: the person has to try again.
        await tenantDb`
          update calendar_connections set status = 'needs_reconnect', last_error_code = 'bad_login', version = version + 1, updated_at = now()
          where tenant_id = ${tenantId} and id = ${connection.id}`;
        return "delivered";
      }
      return failed.outcome;
    }
    if (!account.ok || !calendars || !calendars.ok) return { outcome: "retry", code: "verify_failed" };

    await tenantDb`
      update calendar_connections set status = 'active', last_error_code = null, version = version + 1, updated_at = now(),
        account_email = coalesce(${account.value.accountEmail}, account_email)
      where tenant_id = ${tenantId} and id = ${connection.id}`;
    await saveCalendars(tenantDb, tenantId, connection.id, connection.membership_id, calendars.value);
    const blocking = await tenantDb<{ id: string }[]>`
      select id from calendar_selections where tenant_id = ${tenantId} and connection_id = ${connection.id} and blocks_availability`;
    for (const selection of blocking) {
      await tenantDb`
        insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
        values (${tenantId}, 'calendar_selection', ${selection.id}, 'calendar.sync', ${tenantDb.json({ selectionId: selection.id, resnapshot: true })}, ${`calendar.sync:${selection.id}:verify:${event.id}`})
        on conflict (tenant_id, dedupe_key) do nothing`;
    }
    return "delivered";
  };
}

/** Keeps the person's choices for calendars they already had. The primary calendar blocks availability until they untick it. */
async function saveCalendars(
  tenantDb: Parameters<EventHandler>[0],
  tenantId: string,
  connectionId: string,
  membershipId: string,
  calendars: CalendarInfo[],
): Promise<void> {
  if (calendars.length === 0) return;
  for (const calendar of calendars) {
    await tenantDb`
      insert into calendar_selections (tenant_id, connection_id, membership_id, calendar_id, name, is_primary, can_write, blocks_availability)
      values (${tenantId}, ${connectionId}, ${membershipId}, ${calendar.id}, ${calendar.name.slice(0, 200)}, ${calendar.primary}, ${calendar.canWrite}, ${calendar.primary})
      on conflict (tenant_id, connection_id, calendar_id) do update
        set name = excluded.name, is_primary = excluded.is_primary, can_write = excluded.can_write,
          writes_here = calendar_selections.writes_here and excluded.can_write, updated_at = now()`;
  }
  // A calendar the person deleted on the provider's side is no longer listed: forget it and its busy time.
  await tenantDb`
    delete from calendar_selections where tenant_id = ${tenantId} and connection_id = ${connectionId}
      and calendar_id <> all(${calendars.map((calendar) => calendar.id)}::text[])`;
}

/** Renews (or first opens) the watch channel of one calendar. The hourly job queues this for channels near their end. */
export function calendarRenewHandler(deps: CalendarDeps = liveCalendarDeps): EventHandler {
  return async (tenantDb, event) => {
    const parsed = selectionPayload.safeParse(event.payload);
    if (!parsed.success) return { outcome: "dead", code: "invalid_calendar_event" };
    const { tenantId } = event;
    await loadKeys(tenantDb, tenantId);
    const [selection] = await tenantDb<{ id: string; connection_id: string; calendar_id: string; channel_id: string | null; channel_resource_id: string | null; channel_expires_at: Date | null }[]>`
      select id, connection_id, calendar_id, channel_id, channel_resource_id, channel_expires_at
      from calendar_selections where tenant_id = ${tenantId} and id = ${parsed.data.selectionId} for update`;
    if (!selection) return "delivered";
    const connection = await readConnection(tenantDb, tenantId, selection.connection_id);
    if (!connection || connection.status !== "active") return "delivered";
    const session = openSession(tenantDb, tenantId, connection, deps);
    if (!session) {
      await markNeedsReconnect(tenantDb, tenantId, connection);
      return "delivered";
    }
    const result = await ensureChannel(tenantDb, tenantId, session, connection, selection, deps.now());
    await session.persist();
    if (result === "revoked") await markNeedsReconnect(tenantDb, tenantId, connection);
    return "delivered";
  };
}

const MAX_STOP_ATTEMPTS = 3;

/** Stops every channel of a connection, then deletes it with everything saved from it. The person's own calendar is left as it is. */
export function calendarDisconnectHandler(deps: CalendarDeps = liveCalendarDeps): EventHandler {
  return async (tenantDb, event) => {
    const parsed = connectionPayload.safeParse(event.payload);
    if (!parsed.success) return { outcome: "dead", code: "invalid_calendar_event" };
    const { tenantId } = event;
    await loadKeys(tenantDb, tenantId);
    const connection = await readConnection(tenantDb, tenantId, parsed.data.connectionId);
    if (!connection) return "delivered";
    if (connection.status !== "disconnecting") return "delivered";

    const channels = await tenantDb<{ channel_id: string; channel_resource_id: string | null }[]>`
      select channel_id, channel_resource_id from calendar_selections
      where tenant_id = ${tenantId} and connection_id = ${connection.id} and channel_id is not null`;
    const session = channels.length ? openSession(tenantDb, tenantId, connection, deps) : null;
    if (session) {
      for (const channel of channels) {
        const stopped = await session.call((provider) => provider.stopWatch(session.credentials, { channelId: channel.channel_id, resourceId: channel.channel_resource_id }));
        // A dead login or an already-gone channel needs no stopping; a passing glitch gets a few tries.
        if (!stopped.ok && stopped.failure.kind !== "revoked" && event.attemptCount < MAX_STOP_ATTEMPTS) {
          await session.persist();
          return stopped.outcome;
        }
      }
    }
    await tenantDb`delete from calendar_connections where tenant_id = ${tenantId} and id = ${connection.id}`;
    return "delivered";
  };
}
