import { impersonateInputSchema, impersonationStartedSchema } from "@/lib/admin-contracts";
import { impersonationCookie } from "@/lib/admin-access";
import { getAdminContext, requireAdminCapability, requireAdminStepUp } from "@/server/admin-context";
import { businessIdFrom, type IdRouteContext } from "@/server/admin/http";
import { startImpersonation } from "@/server/admin/impersonation";
import { env } from "@/server/env";
import { parseJsonBody, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "View as this business". The token goes only into an HttpOnly cookie; the body carries the session facts for the banner. */
export async function POST(request: Request, context: IdRouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const admin = await getAdminContext(request.headers);
    requireAdminCapability(admin, "impersonate");
    const input = await parseJsonBody(request, impersonateInputSchema);
    if (input.write) {
      requireAdminCapability(admin, "impersonateWrite");
      requireAdminStepUp(admin);
    }
    const started = await startImpersonation(admin.userId, await businessIdFrom(context), input.reason, input.write);
    const body = impersonationStartedSchema.parse({ sessionId: started.sessionId, endsAt: started.endsAt, writeAccess: input.write });
    return new Response(JSON.stringify({ data: body }), {
      status: 201,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Set-Cookie": impersonationCookie(started.token, env().NODE_ENV === "production"),
      },
    });
  } catch (error: unknown) {
    return routeErrorResponse(error, "admin.impersonation.start", requestId);
  }
}
