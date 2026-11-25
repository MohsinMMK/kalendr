import { enforceLimit, routeErrorResponse } from "@/server/http";
import { followBookingLink } from "@/server/booking-links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const privateHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

/**
 * A printed or bio short link (feature 52). Counts the visit and sends the visitor to the business's booking page, with the
 * campaign tags and prefill the owner chose. An unknown or switched-off code gets a bare 404, so nothing says which codes exist.
 */
export async function GET(request: Request, context: { params: Promise<{ code: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "booking_link.ip");
    const path = await followBookingLink((await context.params).code);
    if (!path) {
      return new Response("This link is no longer available.", { status: 404, headers: { ...privateHeaders, "Content-Type": "text/plain; charset=utf-8" } });
    }
    // A path on this site, so the redirect stays on whichever address the visitor used.
    return new Response(null, { status: 302, headers: { ...privateHeaders, Location: path } });
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.booking_link", requestId);
  }
}
