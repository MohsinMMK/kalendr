import { getAdminContext, requireAdminCapability } from "@/server/admin-context";
import { businessIdFrom, type IdRouteContext } from "@/server/admin/http";
import { tenantHealth } from "@/server/admin/tenants";
import { dataResponse, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: IdRouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const admin = await getAdminContext(request.headers);
    requireAdminCapability(admin, "readOverview");
    return dataResponse(await tenantHealth(admin.userId, await businessIdFrom(context)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "admin.tenants.health", requestId);
  }
}
