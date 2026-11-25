import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { orderRuleInput, setOrderRule } from "@/server/waitlist-staff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Chooses who is asked first: longest waiting, or the soonest existing booking. Setting the same value again changes nothing. */
export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { orderRule } = await parseJsonBody(request, orderRuleInput);
    return dataResponse(await setOrderRule(context, orderRule));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.waitlist.settings", requestId);
  }
}
