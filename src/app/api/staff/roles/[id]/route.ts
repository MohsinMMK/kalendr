import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { customRoleUpdateSchema } from "@/lib/enterprise-contracts";
import { deleteCustomRole, updateCustomRole } from "@/server/enterprise/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { id } = await params;
    return dataResponse(await updateCustomRole(context, id, await parseJsonBody(request, customRoleUpdateSchema)), 200);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.roles.update", requestId);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { id } = await params;
    return dataResponse(await deleteCustomRole(context, id), 200);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.roles.delete", requestId);
  }
}
