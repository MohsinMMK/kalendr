import { serviceRoutingSchema } from "@/lib/routing-contracts";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { getServiceRouting, saveServiceRouting } from "@/server/routing-admin";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await getServiceRouting(context, (await params).id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.routing.service.read", requestId);
  }
}

/** Saves how a service gives out "anyone" bookings. Saving the same values again changes nothing but the version. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await saveServiceRouting(context, (await params).id, await parseJsonBody(request, serviceRoutingSchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.routing.service.save", requestId);
  }
}
