import { loadBookingPageDefaults, storedProfileFields, updateBusinessProfile } from "@/server/business-profile";
import { staffBusinessProfileSchema } from "@/server/contracts";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { getStaffContext, requirePermission } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The business-wide clock and week start the booking page uses. Staff who manage settings only. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await loadBookingPageDefaults(context));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.settings.business_profile", requestId);
  }
}

/** Changes the business type, renamed words and switched features. Owners and admins only. */
export async function PATCH(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    requirePermission(context, "settings.manage");
    const input = await parseJsonBody(request, staffBusinessProfileSchema);
    const profile = await updateBusinessProfile(context, input);
    return dataResponse(storedProfileFields(profile));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.settings.business_profile", requestId);
  }
}
