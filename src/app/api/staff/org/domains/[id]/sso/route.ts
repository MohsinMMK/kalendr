import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, getStaffContext } from "@/server/staff-context";
import { ssoConnectionSchema, ssoStatusSchema } from "@/lib/enterprise-contracts";
import { removeSsoConnection, saveSsoConnection, setSsoStatus } from "@/server/enterprise/domains";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotImpersonating(context);
    const { id } = await params;
    return dataResponse(await saveSsoConnection(context, id, await parseJsonBody(request, ssoConnectionSchema)), 200);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.org.sso.save", requestId);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotImpersonating(context);
    const { id } = await params;
    return dataResponse(await setSsoStatus(context, id, (await parseJsonBody(request, ssoStatusSchema)).status), 200);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.org.sso.status", requestId);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotImpersonating(context);
    const { id } = await params;
    return dataResponse(await removeSsoConnection(context, id), 200);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.org.sso.remove", requestId);
  }
}
