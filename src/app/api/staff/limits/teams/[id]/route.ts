import { deleteLimitTeam } from "@/server/booking-limits-admin";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const { id } = await context.params;
    return dataResponse(await deleteLimitTeam(staff, id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.limits.team.delete", requestId);
  }
}
