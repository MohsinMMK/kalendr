import { ApiError } from "@/server/api-error";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { getStaffContext, requirePermission } from "@/server/staff-context";
import { sendTestEvent } from "@/server/webhooks/admin";
import { webhookIdParam } from "@/server/webhooks/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    requirePermission(context, "api.manage");
    const id = webhookIdParam.safeParse((await params).id);
    if (!id.success) throw new ApiError(404, "webhook_not_found", "That webhook address was not found.");
    return dataResponse(await sendTestEvent(context, id.data), 202);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.webhooks.test", requestId);
  }
}
