import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { duplicateWorkflow } from "@/server/workflows/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    return dataResponse(await duplicateWorkflow(staff, (await params).id), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.workflows.duplicate", requestId);
  }
}
