import type postgres from "postgres";

import { resolvePermissions, type PermissionOverrides, type StaffRole } from "../lib/permissions";
import { localParts, quietUntil } from "../lib/quiet-hours";
import { alertTime, STAFF_DIGEST_EVENT, staffDigestSchema, type StaffDigest } from "../lib/staff-alerts";
import { forEachTenant, type JobSummary } from "./jobs";

/**
 * The morning summary for staff (feature 56), checked every 15 minutes. For each person whose digest is on and whose chosen
 * local time has come, it works out their day (bookings, requests waiting, yesterday's cancellations) and queues one outbox row
 * for the worker to email. A day with nothing to say sends nothing. The business's local day is stamped on the person, so a
 * day is never sent twice, and the outbox key repeats the guard. A person in quiet hours gets it when those end.
 */
const LIST_LIMIT = 12;
const DEFAULT_DIGEST_MINUTE = 420;

interface Member {
  id: string;
  user_id: string;
  role: StaffRole;
  permission_overrides: PermissionOverrides;
  custom_permissions: string[] | null;
  digest_enabled: boolean | null;
  digest_minute: number | null;
  digest_sent_on: string | null;
  quiet_start_minute: number | null;
  quiet_end_minute: number | null;
}

interface Line extends Record<string, unknown> {
  starts_at: Date;
  first_name: string;
  service: string;
}

export function sendStaffDigests(database: postgres.Sql, now: () => Date = () => new Date()): Promise<JobSummary> {
  return forEachTenant(database, "staff_digest", async (tenantDb, tenantId) => {
    const at = now();
    const [tenant] = await tenantDb<{ timezone: string }[]>`select timezone from tenants where id = ${tenantId}`;
    if (!tenant) return 0;
    const { minute, day } = localParts(at, tenant.timezone);
    const members = await tenantDb<Member[]>`
      select membership.id, membership.user_id, membership.role, membership.permission_overrides, membership.digest_enabled, membership.digest_minute, membership.digest_sent_on::text as digest_sent_on, membership.quiet_start_minute, membership.quiet_end_minute,
        (select custom_role.permissions from custom_roles as custom_role where custom_role.tenant_id = membership.tenant_id and custom_role.id = membership.custom_role_id) as custom_permissions
      from memberships as membership where membership.tenant_id = ${tenantId} and membership.is_active for update of membership`;
    let queued = 0;
    for (const member of members) {
      const enabled = member.digest_enabled ?? (member.role === "owner" || member.role === "admin");
      if (!enabled || member.digest_sent_on === day || minute < (member.digest_minute ?? DEFAULT_DIGEST_MINUTE)) continue;
      const permissions = resolvePermissions(member.role, member.permission_overrides, member.custom_permissions);
      if (!permissions.includes("appointments.book") && !permissions.includes("appointments.status")) continue;

      const digest = await compose(tenantDb, tenantId, tenant.timezone, day, member, at);
      // Stamped either way: a day with nothing to say is still a day that has been looked at.
      await tenantDb`update memberships set digest_sent_on = ${day}::date where tenant_id = ${tenantId} and id = ${member.id}`;
      if (!digest) continue;
      const hold = quietUntil(at, tenant.timezone, member.quiet_start_minute, member.quiet_end_minute);
      await tenantDb`
        insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key, available_at)
        values (${tenantId}, 'staff_digest', ${member.id}, ${STAFF_DIGEST_EVENT}, ${tenantDb.json(digest)},
          ${`staff.digest:${member.id}:${day}`}, ${(hold ?? at).toISOString()}::timestamptz)
        on conflict (tenant_id, dedupe_key) do nothing`;
      queued += 1;
    }
    return queued;
  });
}

async function compose(tenantDb: postgres.TransactionSql, tenantId: string, timeZone: string, day: string, member: Member, now: Date): Promise<StaffDigest | null> {
  // A practitioner sees their own day; everyone else with schedule access sees the business's.
  const own = member.role === "practitioner";
  const start = tenantDb`(${day}::date)::timestamp at time zone ${timeZone}`;
  const end = tenantDb`((${day}::date + 1)::timestamp at time zone ${timeZone})`;
  const yesterday = tenantDb`((${day}::date - 1)::timestamp at time zone ${timeZone})`;
  const mine = own ? tenantDb`and appointment.practitioner_id in (select id from practitioners where tenant_id = ${tenantId} and auth_user_id = ${member.user_id})` : tenantDb``;
  // Someone limited to some locations hears only about those; no rows (or an owner) means every location.
  const here = member.role === "owner" ? tenantDb`` : tenantDb`and (
    not exists (select 1 from membership_locations as reach where reach.tenant_id = ${tenantId} and reach.membership_id = ${member.id})
    or appointment.location_id in (select reach.location_id from membership_locations as reach where reach.tenant_id = ${tenantId} and reach.membership_id = ${member.id}))`;

  const today = await tenantDb<Line[]>`
    select appointment.starts_at, patient.first_name, service.name as service
    from appointments as appointment
    join patients as patient on patient.tenant_id = appointment.tenant_id and patient.id = appointment.patient_id
    join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
    where appointment.tenant_id = ${tenantId} and appointment.status in ('booked', 'checked_in')
      and appointment.starts_at >= ${start} and appointment.starts_at < ${end} ${mine} ${here}
    order by appointment.starts_at limit ${LIST_LIMIT}`;
  const [count] = await tenantDb<{ total: number }[]>`
    select count(*)::int as total from appointments as appointment
    where appointment.tenant_id = ${tenantId} and appointment.status in ('booked', 'checked_in')
      and appointment.starts_at >= ${start} and appointment.starts_at < ${end} ${mine} ${here}`;
  const [waiting] = await tenantDb<{ total: number }[]>`
    select count(*)::int as total from appointments as appointment
    where appointment.tenant_id = ${tenantId} and appointment.status = 'requested' and appointment.starts_at > ${now.toISOString()}::timestamptz ${mine} ${here}`;
  const cancelled = await tenantDb<Line[]>`
    select appointment.starts_at, patient.first_name, service.name as service
    from appointments as appointment
    join patients as patient on patient.tenant_id = appointment.tenant_id and patient.id = appointment.patient_id
    join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
    where appointment.tenant_id = ${tenantId} and appointment.status = 'cancelled'
      and appointment.cancelled_at >= ${yesterday} and appointment.cancelled_at < ${start} ${mine} ${here}
    order by appointment.starts_at limit ${LIST_LIMIT}`;

  const todayCount = count?.total ?? 0;
  const waitingCount = waiting?.total ?? 0;
  if (todayCount === 0 && waitingCount === 0 && cancelled.length === 0) return null;
  const line = (row: Line) => ({ time: alertTime(row.starts_at, timeZone, now), service: row.service.slice(0, 160), firstName: row.first_name.slice(0, 80) });
  return staffDigestSchema.parse({
    membershipId: member.id, day, today: today.map(line), todayCount, waiting: waitingCount, cancelled: cancelled.map(line),
  });
}
