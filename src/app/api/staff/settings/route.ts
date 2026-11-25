import { staffServiceModesSchema } from "@/server/contracts";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { getStaffContext, requirePermission } from "@/server/staff-context";
import { updateStaffServiceModes } from "@/server/staff-operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    requirePermission(context, "settings.manage");
    const input = await parseJsonBody(request, staffServiceModesSchema);
    return dataResponse(await updateStaffServiceModes(context, input));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.settings.services", requestId);
  }
}
