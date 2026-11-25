import { graphEventKey, graphPayloadSchema, ingestNotification, notificationTokenValid, readRawBody } from "@/server/calendar-webhooks";
import { enforceLimit, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/**
 * Microsoft Graph change notifications. When a subscription is created Microsoft first posts with a
 * `validationToken` query value that must be echoed back as plain text within seconds; that is answered
 * before anything else. Real notifications carry a `clientState` on every item: each is compared in
 * constant time, and one wrong item refuses the whole request. Repeats and unknown subscriptions get a 202.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const validationToken = new URL(request.url).searchParams.get("validationToken");
    if (validationToken !== null) {
      if (validationToken.length > 1_000) return new Response(null, { status: 400, headers: noStore });
      return new Response(validationToken, { status: 200, headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" } });
    }
    await enforceLimit(request, "calendar_webhook.ip");
    const raw = await readRawBody(request);
    let parsed: ReturnType<typeof graphPayloadSchema.safeParse>;
    try {
      parsed = graphPayloadSchema.safeParse(JSON.parse(raw));
    } catch {
      return new Response(null, { status: 400, headers: noStore });
    }
    if (!parsed.success) return new Response(null, { status: 400, headers: noStore });
    if (!parsed.data.value.every((item) => notificationTokenValid(item.clientState))) {
      return Response.json({ error: { code: "unauthorized" } }, { status: 401, headers: noStore });
    }
    for (const item of parsed.data.value) {
      await ingestNotification({ provider: "microsoft", channelId: item.subscriptionId, eventKey: `${item.subscriptionId}:${graphEventKey(item)}` });
    }
    return Response.json({ data: { received: parsed.data.value.length } }, { status: 202, headers: noStore });
  } catch (error: unknown) {
    return routeErrorResponse(error, "webhooks.microsoft_graph", requestId);
  }
}
