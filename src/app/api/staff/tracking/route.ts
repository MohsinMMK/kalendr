import { trackingUpdateSchema } from "@/lib/embed/tracking";
import { getTrackingSettings, saveTrackingSettings } from "@/server/embed-tracking";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext, requirePermission } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    requirePermission(context, "settings.manage");
    return dataResponse(await getTrackingSettings(context));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.tracking.read", requestId);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    requirePermission(context, "settings.manage");
    return dataResponse(await saveTrackingSettings(context, await parseJsonBody(request, trackingUpdateSchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.tracking.update", requestId);
  }
}
