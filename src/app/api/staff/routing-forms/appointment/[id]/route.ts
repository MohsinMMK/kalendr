import { dataResponse, routeErrorResponse } from "@/server/http";
import { getAppointmentRouting } from "@/server/routing-forms/trace";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How a booking was routed, or null when it did not come through a routing form. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await getAppointmentRouting(await getStaffContext(request.headers), (await params).id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.routing_forms.trace", requestId);
  }
}
