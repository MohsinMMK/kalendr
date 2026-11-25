import "server-only";

import { randomInt } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";

import { getDatabase, requireDatabase, withTenant } from "@/db/client";
import { auditEvents, bookingShortLinks, services } from "@/db/schema";
import { bookingLinkPath, shortCodePattern, SHORT_CODE_ALPHABET, SHORT_CODE_LENGTH, type BookingLinkInput, type BookingLinkView } from "@/lib/booking-links";

import { ApiError } from "./api-error";
import { requirePermission, type StaffContext } from "./staff-context";

const MAX_LINKS = 200;

function newCode(): string {
  let code = "";
  for (let index = 0; index < SHORT_CODE_LENGTH; index++) code += SHORT_CODE_ALPHABET[randomInt(SHORT_CODE_ALPHABET.length)];
  return code;
}

function view(row: typeof bookingShortLinks.$inferSelect): BookingLinkView {
  return { id: row.id, code: row.code, label: row.label, targetPath: row.targetPath, clicks: row.clicks, isActive: row.isActive, createdAt: row.createdAt.toISOString() };
}

export async function listBookingLinks(context: StaffContext): Promise<BookingLinkView[]> {
  requirePermission(context, "settings.manage");
  if (context.preview) return [];
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.select().from(bookingShortLinks).where(eq(bookingShortLinks.tenantId, context.tenantId))
      .orderBy(desc(bookingShortLinks.createdAt)).limit(MAX_LINKS);
    return rows.map(view);
  });
}

export async function createBookingLink(context: StaffContext, input: BookingLinkInput): Promise<BookingLinkView> {
  requirePermission(context, "settings.manage");
  if (context.preview) throw new ApiError(409, "preview_only", "Short links need a database.");
  const path = bookingLinkPath(context.clinicSlug, input);
  return withTenant(context.tenantId, async (transaction) => {
    if (input.serviceSlug) {
      const [service] = await transaction.select({ id: services.id }).from(services)
        .where(and(eq(services.tenantId, context.tenantId), eq(services.slug, input.serviceSlug))).limit(1);
      if (!service) throw new ApiError(422, "service_not_found", "That service does not exist.", { serviceSlug: ["Choose one of your services."] });
    }
    const [count] = await transaction.select({ total: sql<number>`count(*)::int` }).from(bookingShortLinks).where(eq(bookingShortLinks.tenantId, context.tenantId));
    if ((count?.total ?? 0) >= MAX_LINKS) throw new ApiError(409, "too_many_links", "You have reached the limit of short links. Delete one you no longer print.");
    for (let attempt = 0; attempt < 6; attempt++) {
      const created = await transaction.transaction(async (savepoint) => {
        const [row] = await savepoint.insert(bookingShortLinks).values({
          tenantId: context.tenantId, code: newCode(), label: input.label, targetPath: path, createdByUserId: context.userId,
        }).onConflictDoNothing({ target: bookingShortLinks.code }).returning();
        return row;
      });
      if (created) {
        // The label is free text the owner typed, so only the link's id is written down.
        await transaction.insert(auditEvents).values({
          tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff",
          action: "settings.short_link.created", outcome: "success", metadata: { linkId: created.id },
        });
        return view(created);
      }
    }
    throw new ApiError(503, "code_unavailable", "We could not make a short link just now. Please try again.");
  });
}

export async function deleteBookingLink(context: StaffContext, id: string): Promise<{ deleted: true }> {
  requirePermission(context, "settings.manage");
  if (context.preview) throw new ApiError(409, "preview_only", "Short links need a database.");
  return withTenant(context.tenantId, async (transaction) => {
    const removed = await transaction.delete(bookingShortLinks)
      .where(and(eq(bookingShortLinks.tenantId, context.tenantId), eq(bookingShortLinks.id, id))).returning({ id: bookingShortLinks.id });
    if (!removed[0]) throw new ApiError(404, "link_not_found", "That link was not found.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff",
      action: "settings.short_link.deleted", outcome: "success", metadata: { linkId: id },
    });
    return { deleted: true } as const;
  });
}

/**
 * The page a printed code opens. Counts the visit in the database function itself (no address or visitor detail is read),
 * and returns nothing for an unknown, switched-off or paused business's code.
 */
export async function followBookingLink(code: string): Promise<string | null> {
  if (!shortCodePattern.test(code) || !getDatabase()) return null;
  const rows = await requireDatabase().execute<{ path: string | null }>(sql`select kalendr_follow_booking_link(${code}) as path`);
  return rows[0]?.path ?? null;
}
