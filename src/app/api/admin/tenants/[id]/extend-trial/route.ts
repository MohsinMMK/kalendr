import { extendTrialInputSchema } from "@/lib/admin-contracts";
import { getAdminContext, requireAdminCapability, requireAdminStepUp } from "@/server/admin-context";
import { businessIdFrom, type IdRouteContext } from "@/server/admin/http";
import { extendTrial } from "@/server/billing/admin-actions";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Gives a trial or Free business up to 60 more days of Growth. Billing or super only; a reason is required and audited. */
export async function POST(request: Request, context: IdRouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const admin = await getAdminContext(request.headers);
    requireAdminCapability(admin, "manageBilling");
    requireAdminStepUp(admin);
    const input = await parseJsonBody(request, extendTrialInputSchema);
    const trialEndsAt = await extendTrial(admin.userId, await businessIdFrom(context), input.days, input.reason);
    return dataResponse({ trialEndsAt });
  } catch (error: unknown) {
    return routeErrorResponse(error, "admin.tenants.extendTrial", requestId);
  }
}
