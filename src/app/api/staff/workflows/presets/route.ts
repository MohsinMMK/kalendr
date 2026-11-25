import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { applyStandardWorkflows } from "@/server/workflows/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    return dataResponse(await applyStandardWorkflows(staff));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.workflows.presets", requestId);
  }
}
