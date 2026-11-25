import { billingSettingsInputSchema } from "@/lib/billing-contracts";
import { updateBillingSettings } from "@/server/billing/plan-changes";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotImpersonating(context);
    return dataResponse(await updateBillingSettings(context, await parseJsonBody(request, billingSettingsInputSchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.billing.settings", requestId);
  }
}
