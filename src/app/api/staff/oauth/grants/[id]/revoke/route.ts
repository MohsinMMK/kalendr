import { revokeGrant } from "@/server/oauth/grants";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, route: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await revokeGrant(context, (await route.params).id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.oauth_grants.revoke", requestId);
  }
}
