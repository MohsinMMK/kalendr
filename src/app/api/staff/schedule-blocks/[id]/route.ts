import { staffUpdateScheduleBlockSchema } from "@/server/contracts";
import { parseJsonBody, dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext, requirePermission } from "@/server/staff-context";
import { deleteStaffScheduleBlock, updateStaffScheduleBlock } from "@/server/staff-operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    requirePermission(staff, "hours.edit");
    const { id } = await context.params;
    const input = await parseJsonBody(request, staffUpdateScheduleBlockSchema);
    return dataResponse(await updateStaffScheduleBlock(staff, id, input));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.schedule-block.update", requestId);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const { id } = await context.params;
    return dataResponse(await deleteStaffScheduleBlock(staff, id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.schedule-block.delete", requestId);
  }
}
