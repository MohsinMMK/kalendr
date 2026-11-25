import { staffUpdateResourceSchema } from "@/server/contracts";
import { parseJsonBody, dataResponse, routeErrorResponse } from "@/server/http";
import { getStaffContext, requirePermission } from "@/server/staff-context";
import { updateStaffResource } from "@/server/staff-operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    requirePermission(staff, "settings.manage");
    const { id } = await context.params;
    const input = await parseJsonBody(request, staffUpdateResourceSchema);
    return dataResponse(await updateStaffResource(staff, id, input));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.resource.update", requestId);
  }
}
