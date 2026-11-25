import { ApiError } from "@/server/api-error";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, getStaffContext, requirePermission, requireRecentStepUp } from "@/server/staff-context";
import { rotateSecret } from "@/server/webhooks/admin";
import { webhookIdParam } from "@/server/webhooks/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    // A signing secret is handed out (or can be redirected): support sessions never get one.
    assertNotImpersonating(context);
    requirePermission(context, "api.manage");
    requireRecentStepUp(context);
    const id = webhookIdParam.safeParse((await params).id);
    if (!id.success) throw new ApiError(404, "webhook_not_found", "That webhook address was not found.");
    return dataResponse(await rotateSecret(context, id.data));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.webhooks.rotate", requestId);
  }
}
