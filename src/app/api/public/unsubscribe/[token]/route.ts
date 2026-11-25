import { unsubscribeByToken } from "@/server/campaigns/unsubscribe";
import { appOrigin } from "@/server/env";
import { enforceLimit, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string }> };

/**
 * The link in the footer of a marketing message. Opening it unsubscribes at once, with no sign-in, and shows a plain
 * confirmation. The token only names a message by its hash; it carries no business or customer in the address.
 */
export async function GET(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "unsubscribe.ip");
    const result = await unsubscribeByToken((await params).token);
    const target = new URL("/unsubscribed", appOrigin());
    target.searchParams.set("status", result.status);
    return new Response(null, { status: 303, headers: { Location: target.toString(), "Cache-Control": "no-store", Referrer: "no-referrer" } });
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.unsubscribe", requestId);
  }
}

/** One-click unsubscribe from a mail app (RFC 8058): the mail app posts `List-Unsubscribe=One-Click` to the same address. */
export async function POST(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "unsubscribe.ip");
    const result = await unsubscribeByToken((await params).token);
    return Response.json({ data: { status: result.status } }, { status: result.status === "invalid" ? 404 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.unsubscribe.post", requestId);
  }
}
