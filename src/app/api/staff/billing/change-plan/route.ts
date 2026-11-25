import { changePlanInputSchema } from "@/lib/billing-contracts";
import { changePlan, optionalIdempotencyKey } from "@/server/billing/plan-changes";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotImpersonating(context);
    const input = await parseJsonBody(request, changePlanInputSchema);
    return dataResponse(await changePlan(context, input.planKey, optionalIdempotencyKey(request)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.billing.change_plan", requestId);
  }
}
