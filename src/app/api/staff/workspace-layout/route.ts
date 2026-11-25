import { workspaceLayoutSchema } from "@/lib/workspace-layout";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { getStaffContext, requirePermission } from "@/server/staff-context";
import { loadWorkspaceLayout, updateWorkspaceLayout } from "@/server/workspace-layout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How the staff workspace is arranged for this business. Every staff member can read it. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await loadWorkspaceLayout(context));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.settings.workspace_layout.read", requestId);
  }
}

/** Replaces the workspace layout for the whole team. Owners and admins only. */
export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    requirePermission(context, "settings.manage");
    const input = await parseJsonBody(request, workspaceLayoutSchema, { maxBytes: 32_000 });
    return dataResponse(await updateWorkspaceLayout(context, input));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.settings.workspace_layout", requestId);
  }
}
