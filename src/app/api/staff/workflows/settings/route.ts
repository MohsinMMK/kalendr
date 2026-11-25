import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { saveWorkflowSettings } from "@/server/workflows/service";
import { workflowSettingsSchema } from "@/lib/workflow-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await saveWorkflowSettings(context, await parseJsonBody(request, workflowSettingsSchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.workflows.settings", requestId);
  }
}
