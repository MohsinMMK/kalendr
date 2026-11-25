import "server-only";

import { TZDate } from "@date-fns/tz";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { withTenant } from "@/db/client";
import { ApiError } from "@/server/api-error";
import { staffContextFor, type ApiKeyContext } from "@/server/api-key-context";
import { cancelBody, rescheduleBody } from "@/server/api-v1-contracts";
import { getAppointment, listAppointments, readAppointment } from "@/server/api-v1-reads";
import { cancelAppointment, rescheduleAppointment } from "@/server/api-v1-writes";
import { mutateStaffAppointment } from "@/server/appointment-repository";

/**
 * The tools that need an API key (feature 54). Each calls the same function as its `/api/v1` route and needs the
 * same scope, so a key that cannot cancel through the API cannot cancel through an assistant either.
 */

const idSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export const todaysBookingsInput = {};
export const rescheduleInput = {
  appointmentId: idSchema,
  startsAt: z.iso.datetime({ offset: true }).describe("The new start, from an open time."),
  personId: idSchema.optional().describe("Move to another person. Defaults to the current one."),
};
export const cancelInput = {
  appointmentId: idSchema,
  reason: cancelBody.shape.reason.describe("Why it was cancelled, 3 to 300 characters."),
};
export const addNoteInput = {
  appointmentId: idSchema,
  note: z.string().trim().min(1).max(2000).describe("Replaces the booking's note."),
};

async function businessDay(context: ApiKeyContext): Promise<{ from: string; to: string }> {
  const [row] = await withTenant(context.tenantId, (tx) => tx.execute<{ timezone: string }>(sql`select timezone from tenants where id = ${context.tenantId}`));
  const zone = row?.timezone ?? "UTC";
  const now = new TZDate(Date.now(), zone);
  const start = new TZDate(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, zone);
  const end = new TZDate(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, zone);
  return { from: new Date(start.getTime()).toISOString(), to: new Date(end.getTime()).toISOString() };
}

export async function todaysBookingsTool(context: ApiKeyContext) {
  const day = await businessDay(context);
  const page = await listAppointments(context.tenantId, day, 100, undefined);
  return { bookings: [...page.items].reverse(), hasMore: page.nextCursor !== null };
}

export async function rescheduleTool(context: ApiKeyContext, input: { appointmentId: string; startsAt: string; personId?: string | undefined }) {
  const body = rescheduleBody.parse({ startsAt: input.startsAt, ...(input.personId ? { staffId: input.personId } : {}) });
  return rescheduleAppointment(context, input.appointmentId, body);
}

export async function cancelTool(context: ApiKeyContext, input: { appointmentId: string; reason?: string | undefined }) {
  return cancelAppointment(context, input.appointmentId, cancelBody.parse(input.reason ? { reason: input.reason } : {}));
}

export async function addNoteTool(context: ApiKeyContext, input: { appointmentId: string; note: string }) {
  const current = await withTenant(context.tenantId, (tx) => readAppointment(tx, context.tenantId, input.appointmentId));
  if (current.status === "cancelled") throw new ApiError(409, "invalid_status_transition", "A cancelled booking cannot be edited.");
  await mutateStaffAppointment(staffContextFor(context), input.appointmentId, { action: "details", notes: input.note, expectedVersion: current.version });
  return getAppointment(context.tenantId, input.appointmentId);
}
