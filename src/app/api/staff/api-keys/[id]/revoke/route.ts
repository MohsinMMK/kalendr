import { revokeApiKey } from "@/server/api-keys-admin";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, route: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    assertNotImpersonating(context);
    return dataResponse(await revokeApiKey(context, (await route.params).id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.api_keys.revoke", requestId);
  }
}
