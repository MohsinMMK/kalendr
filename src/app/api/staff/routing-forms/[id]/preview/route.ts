import { previewSchema } from "@/lib/routing-forms";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { previewRoutingForm } from "@/server/routing-forms/forms";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Shows which route would match and who would be offered. Writes nothing: it runs in a read-only transaction. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const input = await parseJsonBody(request, previewSchema);
    return dataResponse(await previewRoutingForm(context, (await params).id, input.answers));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.routing_forms.preview", requestId);
  }
}
