import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { attributeUpdateSchema } from "@/lib/enterprise-contracts";
import { deleteAttribute, updateAttribute } from "@/server/enterprise/attributes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { id } = await params;
    return dataResponse(await updateAttribute(context, id, await parseJsonBody(request, attributeUpdateSchema)), 200);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.attributes.update", requestId);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { id } = await params;
    return dataResponse(await deleteAttribute(context, id), 200);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.attributes.delete", requestId);
  }
}
