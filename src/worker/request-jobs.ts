import type postgres from "postgres";

import { resolvePermissions, type StaffRole } from "../lib/permissions";
import { alertTime, alertTitle, appointmentLink, mayReceiveAlert } from "../lib/staff-alerts";
import { refundInFull } from "../server/payments/business-fault-refund";
import { planAppointment } from "../server/workflows/engine";
import { postgresRunner } from "../server/workflows/runner";
import { forEachTenant, type JobSummary } from "./jobs";

/**
 * Requests nobody answered (feature 41). Two things, once a minute:
 *  - a request whose start time has passed is closed as `expired`, frees whatever it held and tells the customer;
 *  - a request that has used half of the time between being asked and its start gets one reminder in the staff inbox.
 * Both are safe to run twice: the expiry only touches rows still `requested`, and the reminder has a dedupe key.
 */

const BATCH = 100;

export function expireRequests(database: postgres.Sql): Promise<JobSummary> {
  return forEachTenant(database, "request_expiry", async (tenantDb, tenantId) => {
    const due = await tenantDb<{ id: string; version: number }[]>`
      select id, version from appointments
      where tenant_id = ${tenantId} and status = 'requested' and starts_at <= now()
      order by starts_at
      limit ${BATCH}
      for update skip locked
    `;
    for (const row of due) {
      const [updated] = await tenantDb<{ version: number }[]>`
        update appointments
        set status = 'expired', confirmation_status = 'declined', proposed_starts = null, version = version + 1, updated_at = now()
        where tenant_id = ${tenantId} and id = ${row.id} and status = 'requested'
        returning version
      `;
      if (!updated) continue;
      await tenantDb`
        update resource_reservations set state = 'released', updated_at = now()
        where tenant_id = ${tenantId} and appointment_id = ${row.id} and state in ('held', 'confirmed')
      `;
      await tenantDb`
        insert into audit_events (tenant_id, appointment_id, actor_type, action, outcome, metadata)
        values (${tenantId}, ${row.id}, 'system', 'appointment.status.expired', 'success',
          ${tenantDb.json({ version: updated.version, via: "request_expiry" })})
      `;
      await tenantDb`
        insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
        values (${tenantId}, 'appointment', ${row.id}, 'appointment.status.expired',
          ${tenantDb.json({ appointmentId: row.id, version: updated.version })},
          ${`appointment.status.expired:${row.id}:${updated.version}`})
        on conflict (tenant_id, dedupe_key) do nothing
      `;
      await planAppointment(postgresRunner(tenantDb), tenantId, row.id, { action: "appointment.status.expired", version: updated.version });
    }
    return due.length;
  });
}

export function remindAboutRequests(database: postgres.Sql): Promise<JobSummary> {
  return forEachTenant(database, "request_expiry", async (tenantDb, tenantId) => {
    const waiting = await tenantDb<{ id: string; starts_at: Date; timezone: string; location_id: string }[]>`
      select appointment.id, appointment.starts_at, tenant.timezone, appointment.location_id
      from appointments as appointment
      join tenants as tenant on tenant.id = appointment.tenant_id
      where appointment.tenant_id = ${tenantId} and appointment.status = 'requested'
        and appointment.starts_at > now()
        and appointment.created_at + (appointment.starts_at - appointment.created_at) / 2 <= now()
      limit ${BATCH}
    `;
    if (waiting.length === 0) return 0;
    const people = await tenantDb<{ id: string; role: StaffRole; permission_overrides: unknown; custom_permissions: string[] | null }[]>`
      select membership.id, membership.role, membership.permission_overrides, custom_role.permissions as custom_permissions
      from memberships as membership
      left join custom_roles as custom_role on custom_role.tenant_id = membership.tenant_id and custom_role.id = membership.custom_role_id
      where membership.tenant_id = ${tenantId} and membership.is_active
    `;
    const recipients = people.filter((person) => mayReceiveAlert(resolvePermissions(person.role, person.permission_overrides as never, person.custom_permissions), "booking_request"));
    // Someone limited to some locations is reminded only about requests at those; owners and people without rows hear all.
    const reachRows = await tenantDb<{ membership_id: string; location_id: string }[]>`
      select membership_id, location_id from membership_locations where tenant_id = ${tenantId}`;
    const reach = new Map<string, Set<string>>();
    for (const row of reachRows) reach.set(row.membership_id, (reach.get(row.membership_id) ?? new Set<string>()).add(row.location_id));
    let written = 0;
    for (const appointment of waiting) {
      const title = `Still waiting for your answer: ${alertTitle("booking_request", alertTime(appointment.starts_at, appointment.timezone))}`;
      for (const person of recipients) {
        const limits = person.role === "owner" ? undefined : reach.get(person.id);
        if (limits && !limits.has(appointment.location_id)) continue;
        const [choice] = await tenantDb<{ in_app: boolean }[]>`
          select in_app from notification_preferences
          where tenant_id = ${tenantId} and membership_id = ${person.id} and kind = 'booking_request'
        `;
        if (choice && !choice.in_app) continue;
        const inserted = await tenantDb`
          insert into staff_notifications (tenant_id, membership_id, kind, title, link, dedupe_key)
          values (${tenantId}, ${person.id}, 'booking_request', ${title}, ${appointmentLink(appointment.id)}, ${`request.reminder:${appointment.id}`})
          on conflict do nothing
          returning id
        `;
        written += inserted.length;
      }
    }
    return written;
  });
}

/**
 * Bookings staff asked to move whose customer never chose a new time (feature 42). After the service's number of days
 * the booking is cancelled by the system and the customer is told, through the same cancelled notice as any other.
 */
export function expireRescheduleRequests(database: postgres.Sql): Promise<JobSummary> {
  return forEachTenant(database, "reschedule_expiry", async (tenantDb, tenantId) => {
    const due = await tenantDb<{ id: string }[]>`
      select appointment.id
      from appointments as appointment
      join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
      where appointment.tenant_id = ${tenantId} and appointment.status = 'reschedule_requested'
        and appointment.reschedule_requested_at + service.reschedule_request_days * interval '1 day' <= now()
      order by appointment.reschedule_requested_at
      limit ${BATCH}
      for update of appointment skip locked
    `;
    for (const row of due) {
      const [updated] = await tenantDb<{ version: number }[]>`
        update appointments
        set status = 'cancelled', cancelled_at = now(), cancelled_by = 'system', cancel_reason_code = 'reschedule_expired',
          reschedule_requested_at = null, confirmation_status = 'declined', version = version + 1, updated_at = now()
        where tenant_id = ${tenantId} and id = ${row.id} and status = 'reschedule_requested'
        returning version
      `;
      if (!updated) continue;
      await tenantDb`
        insert into audit_events (tenant_id, appointment_id, actor_type, action, outcome, metadata)
        values (${tenantId}, ${row.id}, 'system', 'appointment.status.cancelled', 'success',
          ${tenantDb.json({ version: updated.version, cancelledBy: "system", reasonCode: "reschedule_expired" })})
      `;
      await tenantDb`
        insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
        values (${tenantId}, 'appointment', ${row.id}, 'appointment.status.cancelled',
          ${tenantDb.json({ appointmentId: row.id, version: updated.version })},
          ${`appointment.status.cancelled:${row.id}:${updated.version}`})
        on conflict (tenant_id, dedupe_key) do nothing
      `;
      await planAppointment(postgresRunner(tenantDb), tenantId, row.id, { action: "appointment.status.cancelled", version: updated.version });
      // The business asked to move it and nobody rebooked: whatever was paid online goes back in full (feature 23's ledger).
      await refundInFull(postgresRunner(tenantDb), { tenantId, appointmentId: row.id, source: "reschedule", reason: "The booking was not moved to a new time" });
    }
    return due.length;
  });
}
