import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { teamUpdateSchema } from "@/lib/enterprise-contracts";
import { deleteTeam, updateTeam } from "@/server/enterprise/teams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { id } = await params;
    return dataResponse(await updateTeam(context, id, await parseJsonBody(request, teamUpdateSchema)), 200);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.teams.update", requestId);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { id } = await params;
    return dataResponse(await deleteTeam(context, id), 200);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.teams.delete", requestId);
  }
}
