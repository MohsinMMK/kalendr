import { listReassignmentsNeeded } from "@/server/enterprise/reassign";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Deactivated people who still have bookings ahead, for the Provisioning screen. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await listReassignmentsNeeded(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.org.reassign.list", requestId);
  }
}
