import "server-only";

import { and, asc, eq } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { appointmentEventLinks, appointments, auditEvents, authUsers, calendarConflicts, memberships, outboxEvents } from "@/db/schema";
import { CALENDAR_WRITE_EVENT, calendarConflictViewSchema, type CalendarConflictView, type ConflictAction } from "@/lib/calendar-sync";

import { ApiError } from "./api-error";
import { mutateStaffAppointment } from "./appointment-repository";
import { can, requirePermission, type StaffContext } from "./staff-context";

/** Open "needs a person" items, oldest first. `membershipId` null means everyone's (owner view). */
export async function listOpenConflicts(transaction: KalendrTransaction, tenantId: string, membershipId: string | null): Promise<CalendarConflictView[]> {
  const rows = await transaction.select({
    id: calendarConflicts.id,
    appointmentId: calendarConflicts.appointmentId,
    kind: calendarConflicts.kind,
    appointmentStartsAt: calendarConflicts.appointmentStartsAt,
    appointmentEndsAt: calendarConflicts.appointmentEndsAt,
    eventStartsAt: calendarConflicts.eventStartsAt,
    eventEndsAt: calendarConflicts.eventEndsAt,
    ownerName: authUsers.name,
    createdAt: calendarConflicts.createdAt,
  }).from(calendarConflicts)
    .innerJoin(memberships, and(eq(memberships.tenantId, calendarConflicts.tenantId), eq(memberships.id, calendarConflicts.membershipId)))
    .innerJoin(authUsers, eq(authUsers.id, memberships.userId))
    .where(and(
      eq(calendarConflicts.tenantId, tenantId),
      eq(calendarConflicts.status, "open"),
      ...(membershipId ? [eq(calendarConflicts.membershipId, membershipId)] : []),
    ))
    .orderBy(asc(calendarConflicts.createdAt));
  return rows.map((row) => calendarConflictViewSchema.parse({
    id: row.id,
    appointmentId: row.appointmentId,
    kind: row.kind,
    appointmentStartsAt: row.appointmentStartsAt.toISOString(),
    appointmentEndsAt: row.appointmentEndsAt.toISOString(),
    eventStartsAt: row.eventStartsAt?.toISOString() ?? null,
    eventEndsAt: row.eventEndsAt?.toISOString() ?? null,
    ownerName: row.ownerName,
    createdAt: row.createdAt.toISOString(),
  }));
}

async function audit(transaction: KalendrTransaction, context: StaffContext, action: string, conflictId: string, appointmentId: string): Promise<void> {
  await transaction.insert(auditEvents).values({
    tenantId: context.tenantId, appointmentId, actorUserId: context.userId, actorType: "staff", action, outcome: "success", metadata: { conflictId },
  });
}

/**
 * Settles one "needs a person" item. The appointment only changes when a person asks for it here:
 *  - move_appointment runs the normal reschedule (customer told, hours and clashes checked) to the event's time;
 *  - restore_event queues a write that puts the calendar event back to the appointment's time;
 *  - dismiss accepts the outside change and stops asking.
 * The calendar's owner, or anyone allowed to manage calendar sync, may settle it; moving the appointment also
 * needs the right to change appointments.
 */
export async function resolveConflict(context: StaffContext, conflictId: string, action: ConflictAction["action"]): Promise<void> {
  if (context.preview || !context.membershipId) throw new ApiError(409, "calendar_unavailable", "Calendar sync is not available in the preview.");
  const membershipId = context.membershipId;
  const manage = can(context, "calendars.manage");
  if (!manage && !can(context, "calendars.own")) throw new ApiError(403, "forbidden", "You don't have permission to connect calendars.");

  const conflict = await withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.select({
      id: calendarConflicts.id,
      appointmentId: calendarConflicts.appointmentId,
      selectionId: calendarConflicts.selectionId,
      membershipId: calendarConflicts.membershipId,
      kind: calendarConflicts.kind,
      eventStartsAt: calendarConflicts.eventStartsAt,
      eventEndsAt: calendarConflicts.eventEndsAt,
      status: calendarConflicts.status,
      appointmentVersion: appointments.version,
      practitionerId: appointments.practitionerId,
    }).from(calendarConflicts)
      .innerJoin(appointments, and(eq(appointments.tenantId, calendarConflicts.tenantId), eq(appointments.id, calendarConflicts.appointmentId)))
      .where(and(eq(calendarConflicts.tenantId, context.tenantId), eq(calendarConflicts.id, conflictId)));
    return row;
  });
  if (!conflict || (conflict.membershipId !== membershipId && !manage)) throw new ApiError(404, "calendar_conflict_not_found", "That item was not found.");
  if (conflict.status !== "open") return;

  if (action === "move_appointment") {
    requirePermission(context, "appointments.book");
    if (conflict.kind !== "moved" || !conflict.eventStartsAt) {
      throw new ApiError(409, "calendar_conflict_not_movable", "The event was deleted, so there is no new time to move to.");
    }
    // The normal reschedule: checks hours and clashes, and tells the customer.
    await mutateStaffAppointment(context, conflict.appointmentId, {
      action: "reschedule",
      startsAt: conflict.eventStartsAt.toISOString(),
      practitionerId: conflict.practitionerId,
      expectedVersion: conflict.appointmentVersion,
      notifyCustomer: true,
    });
  }

  await withTenant(context.tenantId, async (transaction) => {
    const settled = await transaction.update(calendarConflicts).set({
      status: action === "move_appointment" ? "moved_appointment" : action === "restore_event" ? "restored_event" : "dismissed",
      resolvedAt: new Date(),
      resolvedBy: context.userId,
    }).where(and(eq(calendarConflicts.tenantId, context.tenantId), eq(calendarConflicts.id, conflictId), eq(calendarConflicts.status, "open")))
      .returning({ id: calendarConflicts.id });
    if (settled.length === 0) return;
    const linkScope = and(
      eq(appointmentEventLinks.tenantId, context.tenantId),
      eq(appointmentEventLinks.appointmentId, conflict.appointmentId),
      eq(appointmentEventLinks.selectionId, conflict.selectionId),
    );
    if (action === "move_appointment") {
      // The event already sits at the new time, so the follow-up write must not insist on the old version of it.
      await transaction.update(appointmentEventLinks).set({ etag: null, updatedAt: new Date() }).where(linkScope);
    } else if (action === "restore_event") {
      await transaction.insert(outboxEvents).values({
        tenantId: context.tenantId, aggregateType: "appointment", aggregateId: conflict.appointmentId, eventType: CALENDAR_WRITE_EVENT,
        payload: { appointmentId: conflict.appointmentId, force: true }, dedupeKey: `calendar.write:${conflict.appointmentId}:restore:${conflictId}`,
      }).onConflictDoNothing();
    } else if (conflict.kind === "moved" && conflict.eventStartsAt && conflict.eventEndsAt) {
      // Accept where the event is now as the new baseline, so the same move is not raised again.
      await transaction.update(appointmentEventLinks).set({
        pushedStartsAt: conflict.eventStartsAt, pushedEndsAt: conflict.eventEndsAt, etag: null, updatedAt: new Date(),
      }).where(linkScope);
    } else {
      await transaction.update(appointmentEventLinks).set({ status: "deleted", updatedAt: new Date() }).where(linkScope);
    }
    await audit(transaction, context, `calendar.conflict_${action}`, conflictId, conflict.appointmentId);
  });
}
