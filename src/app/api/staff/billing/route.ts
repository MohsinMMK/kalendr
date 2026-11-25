import { requireBillingRead } from "@/server/billing/plan-changes";
import { getBillingState } from "@/server/billing/subscriptions";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    requireBillingRead(context);
    return dataResponse(await getBillingState(context));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.billing.state", requestId);
  }
}
