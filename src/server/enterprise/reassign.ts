import "server-only";

import { sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { requirePermission, type StaffContext } from "@/server/staff-context";

export interface ReassignmentNeeded {
  /** The time off that closed this person's calendar. Open it in the reassign dialog to move their bookings (feature 20). */
  timeOffId: string;
  practitionerId: string;
  name: string;
  bookings: number;
}

/**
 * People who were deactivated or removed (by the company directory, or by hand) and still have bookings ahead. Their calendar is closed by a long
 * time off, so the bookings are on the same reassign list as any leave: a person moves each one, nothing is cancelled or deleted.
 */
export async function listReassignmentsNeeded(context: StaffContext): Promise<ReassignmentNeeded[]> {
  requirePermission(context, "appointments.book");
  if (context.preview) return [];
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.execute<{ time_off_id: string; practitioner_id: string; name: string; bookings: number }>(sql`
      select leave.id as time_off_id, practitioner.id as practitioner_id, practitioner.name,
        (select count(*)::int from appointments as appointment
          where appointment.tenant_id = leave.tenant_id and appointment.practitioner_id = leave.practitioner_id
            and appointment.status in ('requested', 'booked') and appointment.ends_at > now()) as bookings
      from time_off as leave
      join practitioners as practitioner on practitioner.tenant_id = leave.tenant_id and practitioner.id = leave.practitioner_id
      left join memberships as membership on membership.tenant_id = practitioner.tenant_id and membership.user_id = practitioner.auth_user_id
      where leave.tenant_id = ${context.tenantId} and leave.ends_at > now() + interval '9 years'
        and (practitioner.auth_user_id is null or not membership.is_active)
      order by practitioner.name`);
    return rows.filter((row) => row.bookings > 0).map((row) => ({ timeOffId: row.time_off_id, practitionerId: row.practitioner_id, name: row.name, bookings: row.bookings }));
  });
}
