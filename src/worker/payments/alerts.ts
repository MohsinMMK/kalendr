import { sql } from "drizzle-orm";

import { resolvePermissions, type PermissionOverrides, type StaffRole } from "../../lib/permissions";
import { alertTime, alertTitle, appointmentLink, mayReceiveAlert, type AlertKind } from "../../lib/staff-alerts";
import { asString, type Runner } from "../../server/workflows/runner";

/**
 * The staff alert a booking normally makes when it is created, made here instead when the payment confirms it.
 * The same rules as the web app's `notifyStaff` (who may be told, what they chose, push only with a device),
 * written against `Runner` because the worker has no drizzle transaction. Never fails the payment: errors are swallowed.
 */
export async function alertStaff(run: Runner, tenantId: string, input: { kind: AlertKind; appointmentId: string; startsAt: Date; dedupeKey: string }): Promise<void> {
  try {
    const [tenant] = await run(sql`select timezone from tenants where id = ${tenantId}`);
    const title = alertTitle(input.kind, alertTime(input.startsAt, asString(tenant?.timezone ?? "UTC")));
    const link = appointmentLink(input.appointmentId);
    const people = await run(sql`select membership.id, membership.role, membership.permission_overrides, custom_role.permissions as custom_permissions from memberships as membership left join custom_roles as custom_role on custom_role.tenant_id = membership.tenant_id and custom_role.id = membership.custom_role_id where membership.tenant_id = ${tenantId} and membership.is_active
      and (membership.role = 'owner'
        or not exists (select 1 from membership_locations as limited where limited.tenant_id = membership.tenant_id and limited.membership_id = membership.id)
        or exists (select 1 from membership_locations as reach join appointments as visit on visit.tenant_id = reach.tenant_id and visit.id = ${input.appointmentId} and visit.location_id = reach.location_id
          where reach.tenant_id = membership.tenant_id and reach.membership_id = membership.id))`);
    for (const person of people) {
      const membershipId = asString(person.id);
      const permissions = resolvePermissions(asString(person.role) as StaffRole, (person.permission_overrides ?? {}) as PermissionOverrides, (person.custom_permissions ?? null) as string[] | null);
      if (!mayReceiveAlert(permissions, input.kind)) continue;
      const [choice] = await run(sql`select in_app, push from notification_preferences where tenant_id = ${tenantId} and kind = ${input.kind} and membership_id = ${membershipId}`);
      if (choice?.in_app ?? true) {
        await run(sql`
          insert into staff_notifications (tenant_id, membership_id, kind, title, link, dedupe_key)
          values (${tenantId}, ${membershipId}, ${input.kind}, ${title}, ${link}, ${input.dedupeKey}) on conflict do nothing`);
      }
      const [device] = await run(sql`select 1 as present from push_subscriptions where tenant_id = ${tenantId} and membership_id = ${membershipId} limit 1`);
      if ((choice?.push ?? true) && device) {
        await run(sql`
          insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
          values (${tenantId}, 'push', ${membershipId}, 'push.send', ${JSON.stringify({ membershipId, title, link, kind: input.kind })}::text::jsonb, ${`push:${membershipId}:${input.dedupeKey}`.slice(0, 200)})
          on conflict (tenant_id, dedupe_key) do nothing`);
      }
    }
  } catch {
    // An alert that cannot be written must never undo a payment.
  }
}
