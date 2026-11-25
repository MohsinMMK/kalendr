import "server-only";

import { and, count, eq, sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditEvents, customRoles, memberships } from "@/db/schema";
import type { CustomRoleInput, CustomRoleUpdateInput, CustomRoleView } from "@/lib/enterprise-contracts";
import { isPermission, permissionKeys, type Permission } from "@/lib/permissions";
import { ApiError, getPostgresErrorCode } from "@/server/api-error";
import type { StaffContext } from "@/server/staff-context";

import { duplicateError, guardOrgRead, guardOrgWrite } from "./guard";

type Row = typeof customRoles.$inferSelect;

function view(row: Row, memberCount: number): CustomRoleView {
  return {
    id: row.id, name: row.name, description: row.description, baseRole: row.baseRole as CustomRoleView["baseRole"],
    permissions: row.permissions.filter(isPermission), version: row.version, memberCount,
  };
}

/** Nobody hands out a permission they don't hold: a role may only contain permissions its author has. */
function requireHeld(context: StaffContext, permissions: readonly string[], already: readonly string[] = []): void {
  const missing = permissions.filter((key) => !already.includes(key) && !context.permissions.includes(key as Permission));
  if (missing.length > 0) throw new ApiError(403, "cannot_grant", "You can't put a permission in a role that you don't have yourself.");
}

/** A role based on Admin makes its holders admins, so only the owner may make or change one. */
function requireOwnerForAdminBase(context: StaffContext, ...bases: (string | undefined)[]): void {
  if (context.role !== "owner" && bases.includes("admin")) throw new ApiError(403, "owner_only", "Only the owner can make or change a role that starts as Admin.");
}

function ordered(permissions: readonly string[]): string[] {
  const wanted = new Set(permissions);
  return permissionKeys.filter((key) => wanted.has(key));
}

export async function listCustomRoles(context: StaffContext): Promise<CustomRoleView[]> {
  guardOrgRead(context);
  if (context.preview) return [];
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.select().from(customRoles).where(eq(customRoles.tenantId, context.tenantId)).orderBy(customRoles.name);
    const counts = await transaction
      .select({ roleId: memberships.customRoleId, total: count() })
      .from(memberships)
      .where(and(eq(memberships.tenantId, context.tenantId), sql`${memberships.customRoleId} is not null`))
      .groupBy(memberships.customRoleId);
    const byRole = new Map(counts.map((entry) => [entry.roleId, entry.total]));
    return rows.map((row) => view(row, byRole.get(row.id) ?? 0));
  });
}

export async function createCustomRole(context: StaffContext, input: CustomRoleInput): Promise<CustomRoleView> {
  guardOrgWrite(context, { plan: true, stepUp: true });
  requireOwnerForAdminBase(context, input.baseRole);
  const permissions = ordered(input.permissions);
  requireHeld(context, permissions);
  try {
    return await withTenant(context.tenantId, async (transaction) => {
      const [row] = await transaction.insert(customRoles).values({
        tenantId: context.tenantId, name: input.name, description: input.description ?? null, baseRole: input.baseRole, permissions,
      }).returning();
      if (!row) throw new Error("Role insert returned no row");
      await transaction.insert(auditEvents).values({
        tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "enterprise.role.created", outcome: "success",
        metadata: { roleId: row.id, baseRole: input.baseRole, permissionCount: permissions.length },
      });
      return view(row, 0);
    });
  } catch (error: unknown) {
    if (getPostgresErrorCode(error) === "23505") throw duplicateError("a role");
    throw error;
  }
}

export async function updateCustomRole(context: StaffContext, roleId: string, input: CustomRoleUpdateInput): Promise<CustomRoleView> {
  guardOrgWrite(context, { plan: true, stepUp: true });
  try {
    return await withTenant(context.tenantId, async (transaction) => {
      const [current] = await transaction.select().from(customRoles)
        .where(and(eq(customRoles.tenantId, context.tenantId), eq(customRoles.id, roleId))).for("update").limit(1);
      if (!current) throw new ApiError(404, "custom_role_not_found", "That role could not be found.");
      if (current.version !== input.version) throw new ApiError(409, "version_conflict", "Someone else changed this role. Reload and try again.");
      requireOwnerForAdminBase(context, current.baseRole, input.baseRole);
      const permissions = input.permissions ? ordered(input.permissions) : current.permissions;
      if (input.permissions) requireHeld(context, permissions, current.permissions);
      const [row] = await transaction.update(customRoles).set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.baseRole !== undefined ? { baseRole: input.baseRole } : {}),
        permissions,
        version: current.version + 1,
        updatedAt: new Date(),
      }).where(and(eq(customRoles.tenantId, context.tenantId), eq(customRoles.id, roleId))).returning();
      if (!row) throw new Error("Role update returned no row");
      // Everyone holding the role keeps the base role in step with it, so the second-factor rules follow a change of base.
      if (input.baseRole !== undefined && input.baseRole !== current.baseRole) {
        await transaction.update(memberships).set({ role: input.baseRole, updatedAt: new Date() })
          .where(and(eq(memberships.tenantId, context.tenantId), eq(memberships.customRoleId, roleId)));
      }
      const granted = permissions.filter((key) => !current.permissions.includes(key));
      const revoked = current.permissions.filter((key) => !permissions.includes(key));
      await transaction.insert(auditEvents).values({
        tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "enterprise.role.updated", outcome: "success",
        metadata: { roleId, granted, revoked, ...(input.baseRole !== undefined && input.baseRole !== current.baseRole ? { baseRole: { from: current.baseRole, to: input.baseRole } } : {}) },
      });
      const [members] = await transaction.select({ total: count() }).from(memberships)
        .where(and(eq(memberships.tenantId, context.tenantId), eq(memberships.customRoleId, roleId)));
      return view(row, members?.total ?? 0);
    });
  } catch (error: unknown) {
    if (getPostgresErrorCode(error) === "23505") throw duplicateError("a role");
    throw error;
  }
}

export async function deleteCustomRole(context: StaffContext, roleId: string): Promise<{ deleted: true }> {
  guardOrgWrite(context, { plan: true, stepUp: true });
  return withTenant(context.tenantId, async (transaction) => {
    const [members] = await transaction.select({ total: count() }).from(memberships)
      .where(and(eq(memberships.tenantId, context.tenantId), eq(memberships.customRoleId, roleId)));
    if ((members?.total ?? 0) > 0) throw new ApiError(409, "role_in_use", "People still have this role. Move them to another role first.");
    const removed = await transaction.delete(customRoles).where(and(eq(customRoles.tenantId, context.tenantId), eq(customRoles.id, roleId))).returning({ id: customRoles.id });
    if (removed.length === 0) throw new ApiError(404, "custom_role_not_found", "That role could not be found.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "enterprise.role.deleted", outcome: "success", metadata: { roleId },
    });
    return { deleted: true as const };
  });
}
