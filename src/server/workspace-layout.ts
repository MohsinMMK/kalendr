import "server-only";

import { eq, sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditEvents, tenants } from "@/db/schema";
import { emptyWorkspaceLayout, parseWorkspaceLayout, type WorkspaceLayout } from "@/lib/workspace-layout";

import { ApiError } from "./api-error";
import { requirePermission, type StaffContext } from "./staff-context";

/** The business's workspace layout. Preview mode keeps layouts in the browser, so it starts empty. */
export async function loadWorkspaceLayout(context: Pick<StaffContext, "tenantId" | "preview">): Promise<WorkspaceLayout> {
  if (context.preview) return emptyWorkspaceLayout;
  try {
    return await withTenant(context.tenantId, async (transaction) => {
      const [row] = await transaction.execute<{ layout: unknown }>(sql`select layout from tenants where id = ${context.tenantId}`);
      return parseWorkspaceLayout(row?.layout);
    });
  } catch {
    // A missing column (migration not yet applied) must not take the workspace down.
    return emptyWorkspaceLayout;
  }
}

/** Saves how the workspace is arranged for the whole team. Owners and admins only, and audited. */
export async function updateWorkspaceLayout(context: StaffContext, layout: WorkspaceLayout): Promise<WorkspaceLayout> {
  requirePermission(context, "settings.manage");
  if (context.role !== "owner" && context.role !== "admin") {
    throw new ApiError(403, "forbidden", "Only the owner or an admin can change how the workspace is arranged.");
  }
  const clean = parseWorkspaceLayout(layout);
  if (context.preview) return clean;
  return withTenant(context.tenantId, async (transaction) => {
    await transaction.update(tenants).set({ layout: clean, updatedAt: new Date() }).where(eq(tenants.id, context.tenantId));
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff",
      action: "settings.workspace_layout", outcome: "success",
      metadata: { pages: Object.keys(clean.pages) },
    });
    return clean;
  });
}
