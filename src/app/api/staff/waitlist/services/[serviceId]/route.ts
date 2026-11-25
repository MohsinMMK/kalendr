import { ApiError } from "@/server/api-error";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { automaticOffersInput, setServiceAutomatic } from "@/server/waitlist-staff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Switches automatic offers on or off for one service. Setting the same value again changes nothing. */
export async function PUT(request: Request, { params }: { params: Promise<{ serviceId: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { serviceId } = await params;
    if (!serviceId || serviceId.length > 80) throw new ApiError(404, "service_not_found", "Service not found.");
    const { automatic } = await parseJsonBody(request, automaticOffersInput);
    return dataResponse(await setServiceAutomatic(context, serviceId, automatic));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.waitlist.automation", requestId);
  }
}
