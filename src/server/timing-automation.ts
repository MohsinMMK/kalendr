import "server-only";

import { sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { pickNearestSlot, type TimingResult } from "@/lib/timing-automation";
import { listAvailability, mutateStaffAppointment } from "@/server/appointment-repository";
import type { StaffContext } from "@/server/staff-context";

interface AffectedRow extends Record<string, unknown> {
  id: string;
  version: number;
  status: "requested" | "booked";
  location_id: string;
  service_id: string;
  starts_at: Date | string;
  ends_at: Date | string;
}

const searchDays = 14;
const dayMs = 24 * 60 * 60 * 1_000;

/**
 * Moves a doctor's upcoming visits that no longer fit their saved hours to the nearest opening with the same
 * doctor. Each move is its own checked transaction, so one conflict can't undo the others, and each one writes
 * the outbox event that tells the patient. Visits with no opening stay where they are for a person to resolve.
 * Checked-in visits are never touched, and a patient is never silently switched to a different doctor.
 */
export async function rescheduleAffectedAppointments(context: StaffContext, practitionerId: string): Promise<TimingResult> {
  const result: TimingResult = { moved: [], unresolved: [] };
  const affected = await withTenant(context.tenantId, (transaction) => transaction.execute<AffectedRow>(sql`
    select appointment.id, appointment.version, appointment.status, appointment.location_id,
      appointment.service_id, appointment.starts_at, appointment.ends_at
    from appointments as appointment
    where appointment.tenant_id = ${context.tenantId}
      and appointment.practitioner_id = ${practitionerId}
      and appointment.status in ('requested', 'booked')
      and appointment.starts_at > now()
      and not exists (
        select 1 from availability_rules as rule
        where rule.tenant_id = appointment.tenant_id
          and rule.practitioner_id = appointment.practitioner_id
          and rule.location_id = appointment.location_id
          and rule.is_active
          and exists (select 1 from availability_schedules as schedule where schedule.tenant_id = rule.tenant_id and schedule.id = rule.schedule_id and schedule.is_default)
          and extract(isodow from appointment.starts_at at time zone rule.timezone) = rule.day_of_week
          and (appointment.starts_at at time zone rule.timezone)::time >= rule.starts_at_local
          and (appointment.ends_at at time zone rule.timezone)::time <= rule.ends_at_local
      )
    order by appointment.starts_at, appointment.id
  `));

  for (const row of affected) {
    const original = new Date(row.starts_at);
    const now = Date.now();
    try {
      const slots = await listAvailability({
        clinicSlug: context.clinicSlug,
        locationId: row.location_id,
        serviceId: row.service_id,
        practitionerId,
        from: new Date(Math.max(now, original.getTime() - searchDays * dayMs)).toISOString(),
        to: new Date(Math.max(now, original.getTime()) + searchDays * dayMs).toISOString(),
        // The visit moves with the length it was booked for.
        durationMinutes: Math.max(5, Math.round((new Date(row.ends_at).getTime() - original.getTime()) / 60_000)),
        keepLength: "1",
      });
      const slot = pickNearestSlot(original.toISOString(), slots);
      if (!slot) {
        result.unresolved.push(row.id);
        continue;
      }
      await mutateStaffAppointment(context, row.id, {
        action: row.status === "requested" ? "suggest" : "reschedule",
        startsAt: slot.startsAt,
        practitionerId,
        expectedVersion: row.version,
      }, { movedByClinic: true });
      result.moved.push({ appointmentId: row.id, from: original.toISOString(), to: slot.startsAt });
    } catch (error: unknown) {
      // The hours are already saved, so a failed move must not fail the request. This visit stays flagged.
      console.error("timing_automation.move_failed", { appointmentId: row.id, error: error instanceof Error ? error.name : "unknown" });
      result.unresolved.push(row.id);
    }
  }
  return result;
}
