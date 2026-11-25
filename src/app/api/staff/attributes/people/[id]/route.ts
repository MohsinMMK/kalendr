import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { personAttributesSchema } from "@/lib/enterprise-contracts";
import { setPersonAttributes } from "@/server/enterprise/attributes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { id } = await params;
    return dataResponse(await setPersonAttributes(context, id, await parseJsonBody(request, personAttributesSchema)), 200);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.attributes.people.set", requestId);
  }
}
