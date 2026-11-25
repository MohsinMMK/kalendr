import { deleteTravel } from "@/server/availability-extras";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { id } = await params;
    return dataResponse(await deleteTravel(context, id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.availability.travel.delete", requestId);
  }
}
