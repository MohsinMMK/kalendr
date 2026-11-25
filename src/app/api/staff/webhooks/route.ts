import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, getStaffContext, requirePermission, requireRecentStepUp } from "@/server/staff-context";
import { createEndpointInput } from "@/server/webhooks/contracts";
import { createEndpoint, listEndpoints } from "@/server/webhooks/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    requirePermission(context, "api.manage");
    return dataResponse({ endpoints: await listEndpoints(context) });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.webhooks.list", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    // A signing secret is handed out (or can be redirected): support sessions never get one.
    assertNotImpersonating(context);
    requirePermission(context, "api.manage");
    requireRecentStepUp(context);
    return dataResponse(await createEndpoint(context, await parseJsonBody(request, createEndpointInput)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.webhooks.create", requestId);
  }
}
