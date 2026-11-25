import { and, asc, eq, inArray } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import { locations, membershipLocations } from "@/db/schema";
import { ApiError } from "@/server/api-error";
import { allowedLocationIds } from "@/server/location-scope";
import type { StaffContext } from "@/server/staff-context";
import type { StaffRole } from "@/lib/permissions";

/**
 * Limiting a team member to some of the business's locations (branch-limited access). No rows means every location. The
 * server reads the rows back on every request (`kalendr_resolve_staff_access`), so a change applies on the person's next click.
 */

export async function loadMembershipLocationIds(transaction: KalendrTransaction, tenantId: string, membershipId: string): Promise<string[]> {
  const rows = await transaction.select({ id: membershipLocations.locationId }).from(membershipLocations)
    .where(and(eq(membershipLocations.tenantId, tenantId), eq(membershipLocations.membershipId, membershipId)))
    .orderBy(asc(membershipLocations.locationId));
  return rows.map((row) => row.id);
}

export interface LocationChange { before: string[]; after: string[]; changed: boolean }

/**
 * Replaces the locations a membership is limited to; an empty list lifts the limit. Owners are never limited. Someone who is
 * themselves limited can hand out only their own locations and can't lift a limit, the way nobody grants a permission they lack.
 */
export async function setMembershipLocations(
  transaction: KalendrTransaction,
  context: StaffContext,
  target: { id: string; role: StaffRole },
  requested: readonly string[],
): Promise<LocationChange> {
  const wanted = await checkMembershipLocations(transaction, context, target.role, requested);
  const before = await loadMembershipLocationIds(transaction, context.tenantId, target.id);
  const changed = before.length !== wanted.length || before.some((id, index) => id !== wanted[index]);
  if (!changed) return { before, after: before, changed: false };
  await transaction.delete(membershipLocations)
    .where(and(eq(membershipLocations.tenantId, context.tenantId), eq(membershipLocations.membershipId, target.id)));
  if (wanted.length > 0) {
    await transaction.insert(membershipLocations).values(wanted.map((locationId) => ({ tenantId: context.tenantId, membershipId: target.id, locationId })));
  }
  return { before, after: wanted, changed: true };
}

/**
 * The rules `setMembershipLocations` applies, without writing anything: the sorted, de-duplicated list to store. Also used for
 * an invite that is not a membership yet (`staff-login-invites.ts`), which keeps its list on the invite row.
 */
export async function checkMembershipLocations(
  transaction: KalendrTransaction,
  context: StaffContext,
  role: StaffRole,
  requested: readonly string[],
): Promise<string[]> {
  const wanted = [...new Set(requested)].sort();
  if (role === "owner" && wanted.length > 0) {
    throw new ApiError(400, "owner_required", "An owner always works at every location.");
  }
  if (wanted.length > 0) {
    const found = await transaction.select({ id: locations.id }).from(locations)
      .where(and(eq(locations.tenantId, context.tenantId), inArray(locations.id, wanted), eq(locations.isActive, true)));
    if (found.length !== wanted.length) {
      throw new ApiError(400, "location_not_found", "One of those locations is no longer there. Reload and choose again.", { locationIds: ["Choose from the locations listed."] });
    }
  }
  const mine = allowedLocationIds(context);
  if (mine && (wanted.length === 0 || wanted.some((id) => !mine.includes(id)))) {
    throw new ApiError(403, "cannot_grant", "You can only give someone locations you work at yourself.");
  }
  return wanted;
}
