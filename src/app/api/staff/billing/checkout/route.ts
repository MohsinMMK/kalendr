import { checkoutInputSchema } from "@/lib/billing-contracts";
import { optionalIdempotencyKey, startCheckout } from "@/server/billing/plan-changes";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotImpersonating(context);
    const input = await parseJsonBody(request, checkoutInputSchema);
    return dataResponse(await startCheckout(context, input.planKey, optionalIdempotencyKey(request)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.billing.checkout", requestId);
  }
}
