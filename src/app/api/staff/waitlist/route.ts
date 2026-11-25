import { getStaffContext, requirePermission } from "@/server/staff-context";
import { createStaffWaitlist, waitlistInput } from "@/server/staff-operations";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    requirePermission(context, "appointments.book");
    return dataResponse(await createStaffWaitlist(context, await parseJsonBody(request, waitlistInput)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.waitlist.create", requestId);
  }
}
