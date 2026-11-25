import { timeOffUpdateSchema } from "@/lib/availability-setup";
import { deleteTimeOff, updateTimeOff } from "@/server/availability-extras";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { id } = await params;
    return dataResponse(await updateTimeOff(context, id, await parseJsonBody(request, timeOffUpdateSchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.availability.time-off.update", requestId);
  }
}

export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { id } = await params;
    return dataResponse(await deleteTimeOff(context, id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.availability.time-off.delete", requestId);
  }
}
