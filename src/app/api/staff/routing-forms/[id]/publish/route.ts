import { revisionSchema } from "@/lib/routing-forms";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { publishRoutingForm } from "@/server/routing-forms/forms";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const input = await parseJsonBody(request, revisionSchema);
    return dataResponse(await publishRoutingForm(context, (await params).id, input.expectedRevision));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.routing_forms.publish", requestId);
  }
}
