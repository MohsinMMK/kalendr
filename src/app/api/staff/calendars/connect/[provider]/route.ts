import { appleConnectInputSchema, calendarProviderSchema } from "@/lib/calendar-sync";
import { ApiError } from "@/server/api-error";
import { beginConnect, connectApple, oauthProviderSchema } from "@/server/calendar-connect";
import { OAUTH_STATE_COOKIE, OAUTH_STATE_MAX_AGE_SECONDS } from "@/server/calendar-oauth-state";
import { appOrigin } from "@/server/env";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ provider: string }> };

function backToProfile(outcome: "error"): Response {
  return new Response(null, { status: 303, headers: { Location: new URL(`/profile?calendar=${outcome}`, appOrigin()).toString(), "Cache-Control": "no-store" } });
}

/**
 * Google and Outlook: a browser navigation that sends the person to the provider's sign-in page. No outside
 * call is made here. A signed state and a cookie tie the answer to this browser and this staff member.
 */
export async function GET(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const provider = oauthProviderSchema.safeParse((await params).provider);
    if (!provider.success) throw new ApiError(404, "provider_not_found", "That calendar is not available.");
    const context = await getStaffContext(request.headers);
    const { redirectTo, nonce } = beginConnect(context, provider.data);
    const secure = appOrigin().startsWith("https://") ? "; Secure" : "";
    return new Response(null, {
      status: 303,
      headers: {
        Location: redirectTo,
        "Cache-Control": "no-store",
        "Set-Cookie": `${OAUTH_STATE_COOKIE}=${nonce}; Path=/api/staff/calendars/callback; HttpOnly; SameSite=Lax; Max-Age=${OAUTH_STATE_MAX_AGE_SECONDS}${secure}`,
      },
    });
  } catch (error: unknown) {
    const answer = routeErrorResponse(error, "staff.calendars.connect", requestId);
    return answer.status === 401 ? answer : backToProfile("error");
  }
}

/** Apple: an Apple ID and an app-specific password. Saved as pending; the worker checks it. */
export async function POST(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const provider = calendarProviderSchema.safeParse((await params).provider);
    if (!provider.success || provider.data !== "apple") throw new ApiError(404, "provider_not_found", "That calendar is not available.");
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    assertNotImpersonating(context);
    const input = await parseJsonBody(request, appleConnectInputSchema, { maxBytes: 2_000 });
    return dataResponse(await connectApple(context, input), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.calendars.connect_apple", requestId);
  }
}
