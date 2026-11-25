import { resumeSubscription } from "@/server/billing/plan-changes";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotImpersonating(context);
    return dataResponse(await resumeSubscription(context));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.billing.resume", requestId);
  }
}
