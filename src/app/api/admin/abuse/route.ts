import { getAdminContext, requireAdminCapability } from "@/server/admin-context";
import { abuseOverview } from "@/server/admin/abuse";
import { dataResponse, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const admin = await getAdminContext(request.headers);
    requireAdminCapability(admin, "readOverview");
    return dataResponse(await abuseOverview(admin.userId));
  } catch (error: unknown) {
    return routeErrorResponse(error, "admin.abuse", requestId);
  }
}
