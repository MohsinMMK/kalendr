import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { deleteWorkflow, updateWorkflow } from "@/server/workflows/service";
import { workflowUpdateSchema } from "@/lib/workflow-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params { params: Promise<{ id: string }> }

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await updateWorkflow(context, (await params).id, await parseJsonBody(request, workflowUpdateSchema, { maxBytes: 64 * 1024 })));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.workflows.update", requestId);
  }
}

export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    return dataResponse(await deleteWorkflow(staff, (await params).id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.workflows.delete", requestId);
  }
}
