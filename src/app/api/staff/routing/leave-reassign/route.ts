import { leaveReassignSchema } from "@/lib/routing-contracts";
import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { reassignLeaveBookings } from "@/server/routing-admin";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Moves bookings from a person on leave to their cover person in one action. Repeating the request with the same key moves nothing twice. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const idempotencyKey = getIdempotencyKey(request);
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await reassignLeaveBookings(context, await parseJsonBody(request, leaveReassignSchema), idempotencyKey));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.routing.leave.reassign", requestId);
  }
}
