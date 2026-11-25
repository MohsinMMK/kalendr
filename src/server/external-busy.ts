import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";

/**
 * SQL for "this staff member is busy in a calendar they connected during [starts, ends)". Meant to sit inside a
 * `where` of the availability query or the booking check, next to the schedule-block clause. It only counts
 * calendars the person ticked as blocking, on connections that are working, and never an event Kalendr wrote
 * itself. Busy time from a connection that needs reconnecting is ignored, so availability falls back to Kalendr's own data.
 */
export function externalBusyClash(tenantId: string, practitionerId: SQL | string, starts: SQL, ends: SQL): SQL {
  return sql`exists (
    select 1
    from external_busy as busy
    join calendar_selections as selection on selection.tenant_id = busy.tenant_id and selection.id = busy.selection_id and selection.blocks_availability
    join calendar_connections as connection on connection.tenant_id = selection.tenant_id and connection.id = selection.connection_id and connection.status = 'active'
    join memberships as membership on membership.tenant_id = busy.tenant_id and membership.id = busy.membership_id and membership.is_active
    join practitioners as person on person.tenant_id = membership.tenant_id and person.auth_user_id = membership.user_id
    where busy.tenant_id = ${tenantId}
      and person.id = ${practitionerId}
      and tstzrange(busy.starts_at, busy.ends_at, '[)') && tstzrange(${starts}, ${ends}, '[)')
      and not exists (
        select 1 from appointment_event_links as link
        where link.tenant_id = busy.tenant_id and link.selection_id = busy.selection_id and link.event_id = busy.source_event_id
      )
  )`;
}

export interface BusyRange {
  startsAt: Date;
  endsAt: Date;
}

/** Joins overlapping or touching ranges into one, in time order. */
export function mergeBusy(ranges: readonly BusyRange[]): BusyRange[] {
  const sorted = [...ranges].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const merged: BusyRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.startsAt.getTime() <= last.endsAt.getTime()) {
      if (range.endsAt.getTime() > last.endsAt.getTime()) last.endsAt = range.endsAt;
    } else {
      merged.push({ startsAt: range.startsAt, endsAt: range.endsAt });
    }
  }
  return merged;
}

/**
 * The times a practitioner is busy in their connected calendars, read from the saved copy (never from
 * the provider), merged, with no titles. For the slot engine. Pass a transaction when the caller already
 * has one open for the business; otherwise one is opened.
 */
export async function getExternalBusy(
  practitionerId: string,
  range: { from: Date; to: Date },
  options: { tenantId: string; transaction?: KalendrTransaction },
): Promise<BusyRange[]> {
  const read = async (transaction: KalendrTransaction) => {
    const rows = await transaction.execute<{ starts_at: Date; ends_at: Date }>(sql`
      select busy.starts_at, busy.ends_at
      from external_busy as busy
      join calendar_selections as selection on selection.tenant_id = busy.tenant_id and selection.id = busy.selection_id and selection.blocks_availability
      join calendar_connections as connection on connection.tenant_id = selection.tenant_id and connection.id = selection.connection_id and connection.status = 'active'
      join memberships as membership on membership.tenant_id = busy.tenant_id and membership.id = busy.membership_id and membership.is_active
      join practitioners as person on person.tenant_id = membership.tenant_id and person.auth_user_id = membership.user_id
      where busy.tenant_id = ${options.tenantId} and person.id = ${practitionerId}
        and busy.starts_at < ${range.to.toISOString()}::timestamptz and busy.ends_at > ${range.from.toISOString()}::timestamptz
        and not exists (
          select 1 from appointment_event_links as link
          where link.tenant_id = busy.tenant_id and link.selection_id = busy.selection_id and link.event_id = busy.source_event_id
        )
      order by busy.starts_at`);
    return rows.map((row) => ({ startsAt: new Date(row.starts_at), endsAt: new Date(row.ends_at) }));
  };
  const rows = options.transaction ? await read(options.transaction) : await withTenant(options.tenantId, read);
  return mergeBusy(rows);
}
