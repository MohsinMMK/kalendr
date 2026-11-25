import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { queueWorkflowTest } from "@/server/workflows/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    return dataResponse(await queueWorkflowTest(staff, (await params).id), 202);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.workflows.test", requestId);
  }
}
