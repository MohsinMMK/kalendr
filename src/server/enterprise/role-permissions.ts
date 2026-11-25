import "server-only";

import { and, eq } from "drizzle-orm";

import type { withTenant } from "@/db/client";
import { customRoles, memberships } from "@/db/schema";

type TenantTransaction = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * The permission keys of the person's custom role, or null when they use their built-in role's preset. Read inside the
 * business's own scope, in the same connection `getStaffContext` already opens, so a role edit applies on the next request.
 */
export async function loadCustomPermissions(transaction: TenantTransaction, tenantId: string, membershipId: string): Promise<string[] | null> {
  const [row] = await transaction
    .select({ permissions: customRoles.permissions })
    .from(memberships)
    .innerJoin(customRoles, and(eq(customRoles.tenantId, memberships.tenantId), eq(customRoles.id, memberships.customRoleId)))
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.id, membershipId)))
    .limit(1);
  return row?.permissions ?? null;
}
