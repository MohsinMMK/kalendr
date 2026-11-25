import { ApiError } from "@/server/api-error";
import { finishConnect, oauthProviderSchema } from "@/server/calendar-connect";
import { OAUTH_STATE_COOKIE } from "@/server/calendar-oauth-state";
import { appOrigin } from "@/server/env";
import { routeErrorResponse } from "@/server/http";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

function back(outcome: "connected" | "error"): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: new URL(`/profile?calendar=${outcome}`, appOrigin()).toString(),
      "Cache-Control": "no-store",
      // The state cookie is single-use.
      "Set-Cookie": `${OAUTH_STATE_COOKIE}=; Path=/api/staff/calendars/callback; HttpOnly; SameSite=Lax; Max-Age=0`,
    },
  });
}

/** The provider sends the person back here with a code. The state is checked before anything is exchanged. */
export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const provider = oauthProviderSchema.safeParse((await params).provider);
    if (!provider.success) throw new ApiError(404, "provider_not_found", "That calendar is not available.");
    const url = new URL(request.url);
    // The person pressed "Cancel" on the provider's page.
    if (url.searchParams.get("error")) return back("error");
    const context = await getStaffContext(request.headers);
    await finishConnect(context, provider.data, {
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      cookieNonce: cookieValue(request, OAUTH_STATE_COOKIE),
    });
    return back("connected");
  } catch (error: unknown) {
    const answer = routeErrorResponse(error, "staff.calendars.callback", requestId);
    return answer.status === 401 ? answer : back("error");
  }
}
