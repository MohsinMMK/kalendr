import "server-only";

import { redirect } from "next/navigation";

import { canOpenPage, holdsAny, type StaffPageId } from "@/lib/page-access";
import type { Permission } from "@/lib/permissions";

import { requireStaffPageContext, type StaffContext } from "./staff-context";

/** Where someone goes when they hold a valid membership but not the permission the screen needs. */
export const permissionDeniedPath = "/access-denied?reason=permission";

/**
 * Loads the signed-in staff member and sends them to the access-denied screen unless they hold at least one of the
 * permissions. Unlike `requirePermission` this is for pages: it never throws a 403, and a refused page view is not
 * written to the activity log (the screen's data requests are, if someone tries them by hand).
 */
export async function requirePagePermission(permissions: Permission | readonly Permission[], requestedSlug?: string): Promise<StaffContext> {
  const context = await requireStaffPageContext(requestedSlug);
  if (!holdsAny(context.permissions, typeof permissions === "string" ? [permissions] : permissions)) redirect(permissionDeniedPath);
  return context;
}

/** The same check, by screen name, using the one table the sidebar reads too (`src/lib/page-access.ts`). */
export async function requirePageAccess(page: StaffPageId, requestedSlug?: string): Promise<StaffContext> {
  const context = await requireStaffPageContext(requestedSlug);
  if (!canOpenPage(context.permissions, page)) redirect(permissionDeniedPath);
  return context;
}
