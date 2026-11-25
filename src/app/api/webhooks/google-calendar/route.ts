import { ingestNotification, notificationTokenValid, readRawBody } from "@/server/calendar-webhooks";
import { routeErrorResponse, enforceLimit } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/**
 * Google Calendar change notifications. Google sends headers only: the channel id, our token, and a message
 * number that rises with each message. The token is compared in constant time; a wrong or missing one is a 401.
 * A repeat, or a channel we no longer know, is still a 200 so Google stops retrying.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "calendar_webhook.ip");
    // The body is empty by design; read it anyway so a huge one is refused before anything else.
    await readRawBody(request);
    if (!notificationTokenValid(request.headers.get("x-goog-channel-token"))) {
      return Response.json({ error: { code: "unauthorized" } }, { status: 401, headers: noStore });
    }
    const channelId = request.headers.get("x-goog-channel-id");
    const message = request.headers.get("x-goog-message-number");
    if (!channelId || channelId.length > 200 || !message || !/^\d{1,12}$/.test(message)) {
      return Response.json({ data: { result: "ignored" } }, { status: 200, headers: noStore });
    }
    const result = await ingestNotification({
      provider: "google", channelId, eventKey: `${channelId}:${message}`, handshake: request.headers.get("x-goog-resource-state") === "sync",
    });
    return Response.json({ data: { result } }, { status: 200, headers: noStore });
  } catch (error: unknown) {
    return routeErrorResponse(error, "webhooks.google_calendar", requestId);
  }
}
