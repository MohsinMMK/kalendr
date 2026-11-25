import { enforceLimit, routeErrorResponse } from "@/server/http";
import { appOrigin } from "@/server/env";
import { resolveShortLinkToken } from "@/server/short-links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ShortLinkContext {
  params: Promise<{ code: string }>;
}

const privateHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

/**
 * The link in an SMS. Turns a short code into the customer's private manage page. An unknown,
 * expired or unreadable code gets the same bare 404, so nothing says which codes exist. The
 * code and the token are never logged.
 */
export async function GET(request: Request, context: ShortLinkContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "short_link.ip");
    const { code } = await context.params;
    const token = await resolveShortLinkToken(code);
    if (!token) {
      return new Response("This link is no longer available.", {
        status: 404,
        headers: { ...privateHeaders, "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return new Response(null, {
      status: 302,
      headers: { ...privateHeaders, Location: `${appOrigin()}/manage/${encodeURIComponent(token)}` },
    });
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.short_link", requestId);
  }
}
