import { sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { declineReasonLabels, isDeclineReason } from "@/lib/approval";
import type { HistoryEntry } from "@/lib/bookings-list";
import { limitOverrideLabels, limitOverrideReasons } from "@/lib/booking-limits";
import { cancelReasonLabels, isCancelReasonCode } from "@/lib/cancel-policy";
import { ApiError } from "@/server/api-error";
import { canUseLocation } from "@/server/location-scope";
import { requirePermission, type StaffContext } from "@/server/staff-context";

/**
 * One booking's history (feature 43): what happened, who did it and when, from the audit trail and the messages that
 * went out. Reasons show as labels. The sealed notes (cancel and reschedule notes, guest lists, answers) are never
 * read here, and the audit metadata never held them.
 */

const actionLabels: Record<string, string> = {
  "appointment.created": "Booked",
  "appointment.confirm": "Confirmed by the customer",
  "appointment.status.booked": "Confirmed",
  "appointment.status.requested": "Waiting for approval",
  "appointment.reschedule": "Moved to a new time",
  "appointment.suggest": "A new time was suggested",
  "appointment.resize": "Length changed",
  "appointment.cancel": "Cancelled",
  "appointment.status.cancelled": "Cancelled",
  "appointment.status.declined": "Request declined",
  "appointment.status.expired": "Request expired",
  "appointment.status.no_show": "Marked as a no-show",
  "appointment.status.checked_in": "Checked in",
  "appointment.status.completed": "Completed",
  "appointment.status.entered_in_error": "Marked as entered in error",
  "appointment.started": "Visit started",
  "appointment.reschedule_requested": "Asked to choose a new time",
  "appointment.reassigned": "Given to someone else",
  "appointment.location_changed": "Where it happens changed",
  "appointment.guests_updated": "Guest list changed",
  "appointment.form_received": "Form received",
  "appointment.details_updated": "Details edited",
};

const messageLabels: Record<string, string> = {
  "appointment.reminder": "Reminder sent",
  "appointment.created": "Confirmation sent",
  "appointment.status.booked": "Confirmation sent",
  "appointment.reschedule": "New time sent",
  "appointment.cancel": "Cancellation sent",
  "appointment.status.cancelled": "Cancellation sent",
  "appointment.status.declined": "Decline notice sent",
  "appointment.status.expired": "Expiry notice sent",
  "appointment.reschedule_requested": "Request to choose a new time sent",
  "appointment.reassigned": "Notice of the new person sent",
  "appointment.location_changed": "Notice of the new place sent",
  "appointment.review_request": "Review request sent",
};

function when(value: unknown, timeZone: string): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone }).format(new Date(value));
}

interface AuditRow extends Record<string, unknown> {
  action: string;
  actor_type: string;
  actor_name: string | null;
  metadata: Record<string, unknown> | null;
  occurred_at: Date | string;
}

export async function getBookingHistory(context: StaffContext, appointmentId: string): Promise<HistoryEntry[]> {
  requirePermission(context, "appointments.status");
  if (context.preview) throw new ApiError(400, "preview_only", "History needs a database.");
  return withTenant(context.tenantId, async (transaction) => {
    const [appointment] = await transaction.execute<{ practitioner_id: string; location_id: string; timezone: string }>(sql`
      select appointment.practitioner_id, appointment.location_id, coalesce(location.timezone, tenant.timezone) as timezone
      from appointments as appointment
      join tenants as tenant on tenant.id = appointment.tenant_id
      join locations as location on location.tenant_id = appointment.tenant_id and location.id = appointment.location_id
      where appointment.tenant_id = ${context.tenantId} and appointment.id = ${appointmentId}
    `);
    if (!appointment || !canUseLocation(context, appointment.location_id)) throw new ApiError(404, "appointment_not_found", "Appointment not found.");
    // A practitioner sees the history of their own bookings only, like the list.
    if (context.role === "practitioner") {
      const [own] = await transaction.execute<{ id: string }>(sql`select id from practitioners where tenant_id = ${context.tenantId} and auth_user_id = ${context.userId} limit 1`);
      if (own?.id !== appointment.practitioner_id) throw new ApiError(404, "appointment_not_found", "Appointment not found.");
    }
    const audits = await transaction.execute<AuditRow>(sql`
      select event.action, event.actor_type, event.metadata, event.occurred_at, member.name as actor_name
      from audit_events as event
      left join auth_users as member on member.id = event.actor_user_id
      where event.tenant_id = ${context.tenantId} and event.appointment_id = ${appointmentId} and event.outcome = 'success'
      order by event.occurred_at, event.id
    `);
    const people = new Map<string, string>();
    const wanted = new Set<string>();
    for (const row of audits) {
      for (const key of ["fromPractitionerId", "toPractitionerId"]) {
        const id = row.metadata?.[key];
        if (typeof id === "string") wanted.add(id);
      }
    }
    if (wanted.size > 0) {
      const named = await transaction.execute<{ id: string; name: string }>(sql`
        select id, name from practitioners where tenant_id = ${context.tenantId} and id in (${sql.join([...wanted].map((id) => sql`${id}`), sql`, `)})
      `);
      for (const person of named) people.set(person.id, person.name);
    }
    const entries: HistoryEntry[] = [];
    for (const row of audits) {
      const label = actionLabels[row.action];
      // Actions that are not part of a booking's story (a permission refusal, a settings change) stay out.
      if (!label) continue;
      const metadata = row.metadata ?? {};
      const detail: string[] = [];
      const from = when(metadata.fromStartsAt, appointment.timezone);
      const to = when(metadata.toStartsAt, appointment.timezone);
      if (from && to) detail.push(`${from} → ${to}`);
      const fromPerson = typeof metadata.fromPractitionerId === "string" ? people.get(metadata.fromPractitionerId) : undefined;
      const toPerson = typeof metadata.toPractitionerId === "string" ? people.get(metadata.toPractitionerId) : undefined;
      if (fromPerson && toPerson) detail.push(`${fromPerson} → ${toPerson}`);
      const reason = typeof metadata.reasonCode === "string" ? metadata.reasonCode : typeof metadata.reason === "string" ? metadata.reason : null;
      if (reason && isCancelReasonCode(reason)) detail.push(cancelReasonLabels[reason]);
      else if (reason && isDeclineReason(reason)) detail.push(declineReasonLabels[reason]);
      if (metadata.hostNoShow === true) detail.push("The business did not turn up");
      // Booked past the usual rules (notice, how far ahead, limits): the reason is one of a fixed list.
      const override = typeof metadata.limitOverride === "string" ? limitOverrideReasons.find((reason) => reason === metadata.limitOverride) : undefined;
      if (override) detail.push(`Booked past the usual rules: ${limitOverrideLabels[override]}`);
      entries.push({
        at: new Date(row.occurred_at).toISOString(),
        kind: "audit",
        action: row.action,
        label,
        actor: { type: row.actor_type === "staff" ? "staff" : row.actor_type === "patient" ? "patient" : "system", ...(row.actor_name ? { name: row.actor_name } : {}) },
        ...(detail.length > 0 ? { detail: detail.join(" · ") } : {}),
      });
    }
    const sent = await transaction.execute<{ template_key: string; sent_at: Date | string }>(sql`
      select template_key, sent_at from notifications
      where tenant_id = ${context.tenantId} and appointment_id = ${appointmentId} and sent_at is not null
      order by sent_at
    `);
    for (const row of sent) {
      const label = messageLabels[row.template_key];
      if (label) entries.push({ at: new Date(row.sent_at).toISOString(), kind: "message", action: row.template_key, label, actor: { type: "system" } });
    }
    return entries.sort((a, b) => a.at.localeCompare(b.at));
  });
}
