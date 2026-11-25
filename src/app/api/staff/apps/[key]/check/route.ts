import { checkApp } from "@/server/apps/admin";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, route: { params: Promise<{ key: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    assertNotImpersonating(context);
    const { key } = await route.params;
    return dataResponse(await checkApp(context, key), 202);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.apps.check", requestId);
  }
}
