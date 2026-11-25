import { and, eq, inArray } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import { memberships, notificationPreferences, practitioners, staffNotifications } from "@/db/schema";
import { appointmentLink } from "@/lib/staff-alerts";

/**
 * A staff alert for named people rather than for everyone who may see the booking. Used when a booking is given to
 * someone else (feature 43): the person who had it and the person who has it now each get one inbox row. It follows
 * the same inbox preferences as every alert, and it never blocks the change it is about.
 */
export async function notifyPeople(
  transaction: KalendrTransaction,
  tenantId: string,
  input: { practitionerIds: string[]; appointmentId: string; startsAt: Date; title: string; dedupeKey: string; exceptUserId?: string | undefined },
): Promise<void> {
  void input.startsAt;
  try {
    await transaction.transaction(async (savepoint) => {
      const people = await savepoint.select({ authUserId: practitioners.authUserId }).from(practitioners)
        .where(and(eq(practitioners.tenantId, tenantId), inArray(practitioners.id, input.practitionerIds)));
      const userIds = people.map((person) => person.authUserId).filter((id): id is string => Boolean(id) && id !== input.exceptUserId);
      if (userIds.length === 0) return;
      const members = await savepoint.select({ id: memberships.id, userId: memberships.userId }).from(memberships)
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.isActive, true), inArray(memberships.userId, userIds)));
      for (const member of members) {
        const [choice] = await savepoint.select({ inApp: notificationPreferences.inApp }).from(notificationPreferences)
          .where(and(eq(notificationPreferences.tenantId, tenantId), eq(notificationPreferences.membershipId, member.id), eq(notificationPreferences.kind, "booking_moved")));
        if (choice && !choice.inApp) continue;
        await savepoint.insert(staffNotifications).values({
          tenantId, membershipId: member.id, kind: "booking_moved", title: input.title, link: appointmentLink(input.appointmentId), dedupeKey: input.dedupeKey,
        }).onConflictDoNothing();
      }
    });
  } catch {
    // An alert that cannot be written never undoes the change it is about.
  }
}
