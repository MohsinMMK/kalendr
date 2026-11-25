import { ApiError } from "@/server/api-error";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, getStaffContext, requirePermission, requireRecentStepUp } from "@/server/staff-context";
import { deleteEndpoint, updateEndpoint } from "@/server/webhooks/admin";
import { updateEndpointInput, webhookIdParam } from "@/server/webhooks/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

async function endpointId(params: Params["params"]): Promise<string> {
  const parsed = webhookIdParam.safeParse((await params).id);
  if (!parsed.success) throw new ApiError(404, "webhook_not_found", "That webhook address was not found.");
  return parsed.data;
}

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    // Changing the address redirects signed events: support sessions may not.
    assertNotImpersonating(context);
    requirePermission(context, "api.manage");
    requireRecentStepUp(context);
    const id = await endpointId(params);
    return dataResponse({ endpoint: await updateEndpoint(context, id, await parseJsonBody(request, updateEndpointInput)) });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.webhooks.update", requestId);
  }
}

export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotImpersonating(context);
    requirePermission(context, "api.manage");
    requireRecentStepUp(context);
    await deleteEndpoint(context, await endpointId(params));
    return dataResponse({ deleted: true });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.webhooks.delete", requestId);
  }
}
