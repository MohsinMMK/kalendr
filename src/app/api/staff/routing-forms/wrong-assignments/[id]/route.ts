import { reviewWrongAssignmentSchema } from "@/lib/routing-forms";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { reviewWrongAssignment } from "@/server/routing-forms/wrong-assignment";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await reviewWrongAssignment(context, (await params).id, await parseJsonBody(request, reviewWrongAssignmentSchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.routing_forms.wrong.review", requestId);
  }
}
