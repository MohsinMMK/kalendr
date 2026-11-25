import { ApiError } from "@/server/api-error";
import { dataResponse, parseQuery, routeErrorResponse } from "@/server/http";
import { getStaffContext, requirePermission } from "@/server/staff-context";
import { listDeliveries } from "@/server/webhooks/admin";
import { deliveryListQuery, webhookIdParam } from "@/server/webhooks/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    requirePermission(context, "api.manage");
    const id = webhookIdParam.safeParse((await params).id);
    if (!id.success) throw new ApiError(404, "webhook_not_found", "That webhook address was not found.");
    const query = parseQuery(request, deliveryListQuery);
    return dataResponse(await listDeliveries(context, { endpointId: id.data, cursor: query.cursor, limit: query.limit }));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.webhooks.deliveries", requestId);
  }
}
