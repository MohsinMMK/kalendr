import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { getStaffContext, requirePermission } from "@/server/staff-context";
import { recallInput, updateStaffRecall } from "@/server/staff-operations";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { requireFeature } from "@/server/business-profile";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    await requireFeature(context, "recalls");
    requirePermission(context, "appointments.book");
    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success) throw new ApiError(404, "recall_not_found", "Recall not found.");
    return dataResponse(await updateStaffRecall(context, id, await parseJsonBody(request, recallInput)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.recall.update", requestId);
  }
}
