import { dataResponse, routeErrorResponse } from "@/server/http";
import { listLeaveBookings } from "@/server/routing-admin";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The bookings that fall in a time off and still sit with the person who is away, and whether the cover person is free for each. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await listLeaveBookings(context, (await params).id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.routing.leave.read", requestId);
  }
}
