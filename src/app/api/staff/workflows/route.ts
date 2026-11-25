import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { createWorkflow, listWorkflows } from "@/server/workflows/service";
import { workflowInputSchema } from "@/lib/workflow-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await listWorkflows(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.workflows.list", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const key = request.headers.get("idempotency-key")?.trim() || undefined;
    return dataResponse(await createWorkflow(context, await parseJsonBody(request, workflowInputSchema, { maxBytes: 64 * 1024 }), key), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.workflows.create", requestId);
  }
}
