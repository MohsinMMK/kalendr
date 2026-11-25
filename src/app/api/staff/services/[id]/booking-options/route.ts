import { serviceBookingOptionsInputSchema } from "@/lib/service-booking-options";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { getServiceBookingOptions, saveServiceBookingOptions } from "@/server/service-booking-options";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Context { params: Promise<{ id: string }> }

export async function GET(request: Request, context: Context): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await getServiceBookingOptions(await getStaffContext(request.headers), (await context.params).id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.service_booking_options.get", requestId);
  }
}

/** Optimized slots and the "Book again" button on an old reschedule link, for one service. */
export async function PUT(request: Request, context: Context): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    return dataResponse(await saveServiceBookingOptions(staff, (await context.params).id, await parseJsonBody(request, serviceBookingOptionsInputSchema, { maxBytes: 500 })));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.service_booking_options.save", requestId);
  }
}
