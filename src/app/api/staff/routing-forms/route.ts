import { routingDraftSchema } from "@/lib/routing-forms";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { createRoutingForm, listRoutingForms } from "@/server/routing-forms/forms";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await listRoutingForms(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.routing_forms.list", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await createRoutingForm(context, await parseJsonBody(request, routingDraftSchema)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.routing_forms.create", requestId);
  }
}
