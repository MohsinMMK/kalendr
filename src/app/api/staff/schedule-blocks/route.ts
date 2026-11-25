import { staffCreateScheduleBlockSchema } from "@/server/contracts";
import { parseJsonBody, dataResponse, routeErrorResponse } from "@/server/http";
import { getStaffContext, requirePermission } from "@/server/staff-context";
import { createStaffScheduleBlock } from "@/server/staff-operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    requirePermission(context, "hours.edit");
    const input = await parseJsonBody(request, staffCreateScheduleBlockSchema);
    return dataResponse(await createStaffScheduleBlock(context, input), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.schedule-block.create", requestId);
  }
}
