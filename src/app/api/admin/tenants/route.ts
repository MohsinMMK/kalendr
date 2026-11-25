import { adminTenantListQuerySchema } from "@/lib/admin-contracts";
import { getAdminContext, requireAdminCapability } from "@/server/admin-context";
import { listTenants } from "@/server/admin/tenants";
import { dataResponse, parseQuery, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const admin = await getAdminContext(request.headers);
    requireAdminCapability(admin, "readOverview");
    return dataResponse(await listTenants(admin.userId, parseQuery(request, adminTenantListQuerySchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "admin.tenants.list", requestId);
  }
}
