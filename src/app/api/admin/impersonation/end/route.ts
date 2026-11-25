import { clearedImpersonationCookie } from "@/lib/admin-access";
import { impersonationCookieName } from "@/lib/admin-contracts";
import { getAdminContext, requireAdminCapability } from "@/server/admin-context";
import { endImpersonation, resolveImpersonation } from "@/server/admin/impersonation";
import { env } from "@/server/env";
import { routeErrorResponse } from "@/server/http";
import { cookieValue } from "@/server/staff-impersonation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ends the live session named by the caller's own cookie and clears the cookie, whether or not a session was still live. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const admin = await getAdminContext(request.headers);
    requireAdminCapability(admin, "impersonate");
    const token = cookieValue(request.headers, impersonationCookieName);
    const live = token ? await resolveImpersonation(admin.userId, token) : null;
    const ended = live ? await endImpersonation(admin.userId, live.sessionId) : false;
    return new Response(JSON.stringify({ data: { ended } }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Set-Cookie": clearedImpersonationCookie(env().NODE_ENV === "production"),
      },
    });
  } catch (error: unknown) {
    return routeErrorResponse(error, "admin.impersonation.end", requestId);
  }
}
