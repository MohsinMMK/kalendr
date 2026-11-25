import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, getStaffContext } from "@/server/staff-context";
import { revokeScimToken } from "@/server/enterprise/scim-tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotImpersonating(context);
    return dataResponse(await revokeScimToken(context, (await params).id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.org.scim.tokens.revoke", requestId);
  }
}
