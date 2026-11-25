import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, getStaffContext } from "@/server/staff-context";
import { domainUpdateSchema } from "@/lib/enterprise-contracts";
import { removeDomain, updateDomain } from "@/server/enterprise/domains";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotImpersonating(context);
    const { id } = await params;
    return dataResponse(await updateDomain(context, id, await parseJsonBody(request, domainUpdateSchema)), 200);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.org.domains.update", requestId);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotImpersonating(context);
    const { id } = await params;
    return dataResponse(await removeDomain(context, id), 200);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.org.domains.remove", requestId);
  }
}
