import { and, eq } from "drizzle-orm";

import { getDatabase, type KalendrTransaction } from "@/db/client";
import { appointments } from "@/db/schema";
import { ApiError, getPostgresErrorCode, mapDatabaseError } from "@/server/api-error";
import {
  databaseUnavailable,
  resolveStaffAppointment,
  setTenant,
  versionConflict,
} from "@/server/appointment-repository";
import { assertLocationVisible } from "@/server/location-scope";
import type { StaffContext } from "@/server/staff-context";

export type AppointmentRow = typeof appointments.$inferSelect;

/**
 * The frame every staff change to one appointment runs in: find it inside the staff member's own business, lock the
 * row, refuse a stale version, and retry when two changes collide at the serializable level. The state change
 * itself is the `work` callback, so approve, decline, cancel and the rest share one set of safety rules.
 */
export async function withLockedStaffAppointment<T>(
  context: StaffContext,
  appointmentId: string,
  expectedVersion: number,
  work: (transaction: KalendrTransaction, current: AppointmentRow) => Promise<T>,
): Promise<T> {
  if (!context.userId || context.preview) throw databaseUnavailable();
  const resolved = await resolveStaffAppointment(context.userId, appointmentId);
  if (!resolved || resolved.tenant_id !== context.tenantId) {
    throw new ApiError(404, "appointment_not_found", "Appointment not found.");
  }
  const database = getDatabase();
  if (!database) throw databaseUnavailable();
  return runLockedTransaction(context.tenantId, appointmentId, expectedVersion, (transaction, current) => {
    // A visit at a location this person is not limited to reads as missing.
    assertLocationVisible(context, current.locationId, () => new ApiError(404, "appointment_not_found", "Appointment not found."));
    return work(transaction, current);
  });
}

/** The same frame for a customer's manage link, where the appointment was already found by its token. */
export async function withLockedAppointment<T>(
  tenantId: string,
  appointmentId: string,
  expectedVersion: number,
  work: (transaction: KalendrTransaction, current: AppointmentRow) => Promise<T>,
): Promise<T> {
  return runLockedTransaction(tenantId, appointmentId, expectedVersion, work);
}

async function runLockedTransaction<T>(
  tenantId: string,
  appointmentId: string,
  expectedVersion: number,
  work: (transaction: KalendrTransaction, current: AppointmentRow) => Promise<T>,
): Promise<T> {
  const database = getDatabase();
  if (!database) throw databaseUnavailable();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await database.transaction(async (transaction) => {
        await setTenant(transaction, tenantId);
        const rows = await transaction.select().from(appointments).where(and(
          eq(appointments.tenantId, tenantId),
          eq(appointments.id, appointmentId),
        )).for("update");
        const current = rows[0];
        if (!current) throw new ApiError(404, "appointment_not_found", "Appointment not found.");
        if (current.version !== expectedVersion) throw versionConflict();
        return work(transaction, current);
      }, { isolationLevel: "serializable" });
    } catch (error) {
      const code = getPostgresErrorCode(error);
      if ((code === "40001" || code === "40P01") && attempt < 2) continue;
      throw mapDatabaseError(error) ?? error;
    }
  }
  throw databaseUnavailable();
}
