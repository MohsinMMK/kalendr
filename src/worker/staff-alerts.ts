import type postgres from "postgres";

import type { PermissionOverrides, StaffRole } from "../lib/permissions";
import { planStaffAlert } from "../lib/staff-alert-plan";
import { alertDetail, alertTitle, STAFF_EMAIL_EVENT, staffEmailJobSchema, pushJobSchema, type AlertKind } from "../lib/staff-alerts";

/**
 * The worker's side of staff alerts (feature 56), for events that happen here rather than in a web request, such as a
 * customer's message arriving. It plans with the same rules as the web app (src/lib/staff-alert-plan.ts) and writes the bell row
 * and the outbox rows for push and email. Free text is never read: the alert holds a first name and nothing the customer wrote.
 */
export interface WorkerAlert {
  kind: AlertKind;
  dedupeKey: string;
  link: string;
  /** The customer the alert is about, for the first name. */
  patientId?: string;
}

interface MemberRow {
  id: string;
  user_id: string;
  role: StaffRole;
  permission_overrides: PermissionOverrides;
  custom_permissions: string[] | null;
  quiet_start_minute: number | null;
  quiet_end_minute: number | null;
}

export async function notifyStaffFromWorker(tenantDb: postgres.TransactionSql, tenantId: string, alert: WorkerAlert, now: Date = new Date()): Promise<number> {
  const [tenant] = await tenantDb<{ timezone: string }[]>`select timezone from tenants where id = ${tenantId}`;
  // Staff limited to some locations hear about a customer only when they could open them: seen or waiting at one of their
  // locations, or not seen anywhere yet (the customer list's rule). Owners and anyone without location rows hear everything.
  const reachesCustomer = alert.patientId ? tenantDb`(
      exists (select 1 from appointments as seen_at join membership_locations as reach on reach.tenant_id = seen_at.tenant_id and reach.membership_id = membership.id and reach.location_id = seen_at.location_id
        where seen_at.tenant_id = membership.tenant_id and seen_at.patient_id = ${alert.patientId})
      or exists (select 1 from waitlist_entries as waiting_at join membership_locations as reach on reach.tenant_id = waiting_at.tenant_id and reach.membership_id = membership.id and reach.location_id = waiting_at.location_id
        where waiting_at.tenant_id = membership.tenant_id and waiting_at.patient_id = ${alert.patientId})
      or not exists (select 1 from appointments as any_visit where any_visit.tenant_id = membership.tenant_id and any_visit.patient_id = ${alert.patientId}))` : tenantDb`true`;
  const members = await tenantDb<MemberRow[]>`
    select membership.id, membership.user_id, membership.role, membership.permission_overrides, membership.quiet_start_minute, membership.quiet_end_minute, custom_role.permissions as custom_permissions from memberships as membership left join custom_roles as custom_role on custom_role.tenant_id = membership.tenant_id and custom_role.id = membership.custom_role_id where membership.tenant_id = ${tenantId} and membership.is_active
      and (membership.role = 'owner'
        or not exists (select 1 from membership_locations as limited where limited.tenant_id = membership.tenant_id and limited.membership_id = membership.id)
        or ${reachesCustomer})`;
  if (members.length === 0) return 0;
  const ids = members.map((member) => member.id);
  const choices = await tenantDb<{ membership_id: string; in_app: boolean; push: boolean; email: boolean }[]>`
    select membership_id, in_app, push, email from notification_preferences
    where tenant_id = ${tenantId} and kind = ${alert.kind} and membership_id in ${tenantDb(ids)}`;
  const devices = await tenantDb<{ membership_id: string }[]>`
    select distinct membership_id from push_subscriptions where tenant_id = ${tenantId} and membership_id in ${tenantDb(ids)}`;
  const choiceOf = new Map(choices.map((row) => [row.membership_id, { inApp: row.in_app, push: row.push, email: row.email }]));
  const withDevice = new Set(devices.map((row) => row.membership_id));
  const [patient] = alert.patientId
    ? await tenantDb<{ first_name: string }[]>`select first_name from patients where tenant_id = ${tenantId} and id = ${alert.patientId}`
    : [];

  const plan = planStaffAlert({
    kind: alert.kind,
    members: members.map((member) => ({
      id: member.id, userId: member.user_id, role: member.role, overrides: member.permission_overrides, customPermissions: member.custom_permissions,
      quietStartMinute: member.quiet_start_minute, quietEndMinute: member.quiet_end_minute,
      choice: choiceOf.get(member.id) ?? null, hasPushDevice: withDevice.has(member.id),
    })),
    aboutAppointment: false,
    now,
    timeZone: tenant?.timezone ?? "UTC",
  });

  const title = alertTitle(alert.kind);
  const detail = alertDetail({ firstName: patient?.first_name });
  for (const entry of plan) {
    if (entry.inApp) {
      await tenantDb`
        insert into staff_notifications (tenant_id, membership_id, kind, title, link, dedupe_key)
        values (${tenantId}, ${entry.membershipId}, ${alert.kind}, ${title}, ${alert.link}, ${alert.dedupeKey})
        on conflict do nothing`;
    }
    if (entry.push) {
      const job = pushJobSchema.parse({ membershipId: entry.membershipId, title, ...(detail ? { body: detail } : {}), link: alert.link, kind: alert.kind });
      await tenantDb`
        insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key, available_at)
        values (${tenantId}, 'push', ${entry.membershipId}, 'push.send', ${tenantDb.json(job)},
          ${`push:${entry.membershipId}:${alert.dedupeKey}`.slice(0, 200)}, ${entry.push.availableAt.toISOString()}::timestamptz)
        on conflict (tenant_id, dedupe_key) do nothing`;
    }
    if (entry.email) {
      const job = staffEmailJobSchema.parse({ membershipId: entry.membershipId, kind: alert.kind, title, ...(detail ? { body: detail } : {}), link: alert.link });
      await tenantDb`
        insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key, available_at)
        values (${tenantId}, 'staff_email', ${entry.membershipId}, ${STAFF_EMAIL_EVENT}, ${tenantDb.json(job)},
          ${`staff-email:${entry.membershipId}:${alert.dedupeKey}`.slice(0, 200)}, ${entry.email.availableAt.toISOString()}::timestamptz)
        on conflict (tenant_id, dedupe_key) do nothing`;
    }
  }
  return plan.length;
}
