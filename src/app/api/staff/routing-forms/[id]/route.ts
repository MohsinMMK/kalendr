import { updateFormSchema } from "@/lib/routing-forms";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { deleteRoutingForm, getRoutingForm, updateRoutingForm } from "@/server/routing-forms/forms";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await getRoutingForm(await getStaffContext(request.headers), (await params).id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.routing_forms.read", requestId);
  }
}

/** Saves the form being edited. Customers keep seeing the published version until it is published again. */
export async function PUT(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const input = await parseJsonBody(request, updateFormSchema);
    return dataResponse(await updateRoutingForm(context, (await params).id, input.draft, input.expectedRevision));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.routing_forms.update", requestId);
  }
}

export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await deleteRoutingForm(context, (await params).id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.routing_forms.delete", requestId);
  }
}
