import { changePlanInputSchema } from "@/lib/admin-contracts";
import { getAdminContext, requireAdminCapability, requireAdminStepUp } from "@/server/admin-context";
import { businessIdFrom, type IdRouteContext } from "@/server/admin/http";
import { changePlanManually } from "@/server/billing/admin-actions";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sets a plan by hand for billing fixes; it charges nobody. Billing or super only; a reason is required and audited. */
export async function POST(request: Request, context: IdRouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const admin = await getAdminContext(request.headers);
    requireAdminCapability(admin, "manageBilling");
    requireAdminStepUp(admin);
    const input = await parseJsonBody(request, changePlanInputSchema);
    await changePlanManually(admin.userId, await businessIdFrom(context), input.planKey, input.reason);
    return dataResponse({ planKey: input.planKey });
  } catch (error: unknown) {
    return routeErrorResponse(error, "admin.tenants.changePlan", requestId);
  }
}
