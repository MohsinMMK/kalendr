import { feedTokenHash, isFeedToken } from "@/server/calendar-feed-token";
import { renderFeed } from "@/server/calendar-feed";
import { enforceLimit, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });

/**
 * A private, subscribe-only calendar of one staff member's appointments. The address is the secret: it is
 * 256 bits, only its hash is stored, and regenerating or turning it off makes the old address a 404. It is
 * rate limited by address and by link, and the response says it must not be indexed or cached by shared caches.
 */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "calendar_feed.ip");
    const raw = (await params).token;
    const token = raw.replace(/\.ics$/i, "");
    if (!isFeedToken(token)) return notFound();
    await enforceLimit(request, "calendar_feed.token", feedTokenHash(token));
    const calendar = await renderFeed(token);
    if (calendar === null) return notFound();
    return new Response(calendar, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="kalendr.ics"',
        "Cache-Control": "private, max-age=300",
        "X-Robots-Tag": "noindex, nofollow",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error: unknown) {
    return routeErrorResponse(error, "calendar_feed", requestId);
  }
}
