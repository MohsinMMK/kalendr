import { and, asc, eq, or } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditEvents, savedViews } from "@/db/schema";
import {
  bookingColumns,
  bookingFilterSchema,
  workspaceTabs,
  MAX_SAVED_VIEWS,
  type SavedView,
  type SavedViewInput,
} from "@/lib/bookings-list";
import { ApiError } from "@/server/api-error";
import { requirePermission, type StaffContext } from "@/server/staff-context";

/**
 * Saved filter sets for the bookings list (feature 43): private to the person who made them, or shared with the
 * team. Anyone who can see the list may read shared views; only the owner removes one. The tab is kept inside the
 * stored filters under `tab`, so a view reopens exactly where it was saved.
 */

function requireMember(context: StaffContext): string {
  if (context.preview || !context.membershipId) throw new ApiError(400, "preview_only", "Saved views need a database.");
  return context.membershipId;
}

type Row = typeof savedViews.$inferSelect;

function toView(row: Row, membershipId: string): SavedView {
  const stored = row.filters as Record<string, unknown>;
  const { tab, ...rest } = stored;
  const filters = bookingFilterSchema.safeParse(rest);
  return {
    id: row.id,
    name: row.name,
    shared: row.shared,
    mine: row.ownerMembershipId === membershipId,
    tab: workspaceTabs.find((value) => value === tab) ?? "upcoming",
    filters: filters.success ? filters.data : {},
    sort: row.sort === "desc" ? "desc" : "asc",
    columns: row.columns.filter((column): column is (typeof bookingColumns)[number] => (bookingColumns as readonly string[]).includes(column)),
  };
}

export async function listSavedViews(context: StaffContext): Promise<SavedView[]> {
  requirePermission(context, "appointments.status");
  if (context.preview || !context.membershipId) return [];
  const membershipId = context.membershipId;
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.select().from(savedViews).where(and(
      eq(savedViews.tenantId, context.tenantId),
      eq(savedViews.page, "bookings"),
      or(eq(savedViews.shared, true), eq(savedViews.ownerMembershipId, membershipId)),
    )).orderBy(asc(savedViews.name));
    return rows.map((row) => toView(row, membershipId));
  });
}

export async function createSavedView(context: StaffContext, input: SavedViewInput): Promise<SavedView> {
  requirePermission(context, "appointments.status");
  const membershipId = requireMember(context);
  return withTenant(context.tenantId, async (transaction) => {
    const mine = await transaction.select({ id: savedViews.id }).from(savedViews).where(and(eq(savedViews.tenantId, context.tenantId), eq(savedViews.ownerMembershipId, membershipId)));
    if (mine.length >= MAX_SAVED_VIEWS) throw new ApiError(409, "too_many_views", `You can keep up to ${MAX_SAVED_VIEWS} saved views.`);
    const [created] = await transaction.insert(savedViews).values({
      tenantId: context.tenantId, ownerMembershipId: membershipId, name: input.name, page: "bookings", shared: input.shared,
      filters: { ...input.filters, tab: input.tab }, sort: input.sort, columns: input.columns,
    }).onConflictDoNothing().returning();
    if (!created) throw new ApiError(409, "view_exists", "You already have a view with that name.", { name: ["You already have a view with that name."] });
    // Names of what changed, never the filter values (a filter can hold a customer's name).
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "bookings.view_saved", outcome: "success",
      metadata: { viewId: created.id, shared: input.shared },
    });
    return toView(created, membershipId);
  });
}

export async function deleteSavedView(context: StaffContext, viewId: string): Promise<{ deleted: boolean }> {
  requirePermission(context, "appointments.status");
  const membershipId = requireMember(context);
  return withTenant(context.tenantId, async (transaction) => {
    // Only the owner can remove it; someone else's id simply matches nothing.
    const removed = await transaction.delete(savedViews).where(and(
      eq(savedViews.tenantId, context.tenantId), eq(savedViews.id, viewId), eq(savedViews.ownerMembershipId, membershipId),
    )).returning({ id: savedViews.id });
    if (removed.length === 0) throw new ApiError(404, "view_not_found", "That view no longer exists, or it is not yours to remove.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "bookings.view_removed", outcome: "success", metadata: { viewId },
    });
    return { deleted: true };
  });
}
