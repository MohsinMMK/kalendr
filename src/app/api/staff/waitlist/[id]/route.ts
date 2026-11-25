import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { getStaffContext, requirePermission } from "@/server/staff-context";
import { updateStaffWaitlist, waitlistStatusInput } from "@/server/staff-operations";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    requirePermission(context, "appointments.book");
    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success) throw new ApiError(404, "waitlist_not_found", "Waitlist entry not found.");
    return dataResponse(await updateStaffWaitlist(context, id, await parseJsonBody(request, waitlistStatusInput)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.waitlist.update", requestId);
  }
}
