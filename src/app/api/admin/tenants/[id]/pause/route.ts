import { pauseInputSchema } from "@/lib/admin-contracts";
import { getAdminContext, requireAdminCapability } from "@/server/admin-context";
import { setTenantPaused } from "@/server/admin/actions";
import { businessIdFrom, type IdRouteContext } from "@/server/admin/http";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pauses or resumes the business's public pages. Setting the same state twice changes nothing, so a double click is safe. */
export async function POST(request: Request, context: IdRouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const admin = await getAdminContext(request.headers);
    requireAdminCapability(admin, "operate");
    const input = await parseJsonBody(request, pauseInputSchema);
    await setTenantPaused(admin.userId, await businessIdFrom(context), input.paused, input.reason);
    return dataResponse({ paused: input.paused });
  } catch (error: unknown) {
    return routeErrorResponse(error, "admin.tenants.pause", requestId);
  }
}
