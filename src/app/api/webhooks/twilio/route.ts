import { createTwilioChannel } from "@/server/channels/sms-twilio";
import { intakeStatuses } from "@/server/channels/webhook-intake";
import { WebhookSignatureError } from "@/server/channels/types";
import { ApiError } from "@/server/api-error";
import { appOrigin, env } from "@/server/env";
import { routeErrorResponse } from "@/server/http";
import { MAX_WEBHOOK_BYTES } from "@/server/messaging/resend-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/**
 * Twilio status callbacks. The signature covers the public URL and the form fields, so the URL
 * is rebuilt from our own origin: behind a proxy, request.url shows the internal address and
 * the check would never pass. A bad signature, or no auth token set, is a 401 with no detail.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const authToken = env().TWILIO_AUTH_TOKEN;
    if (!authToken) return Response.json({ error: { code: "unauthorized" } }, { status: 401, headers: noStore });

    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_WEBHOOK_BYTES) throw new ApiError(413, "request_too_large", "The request is too large.");
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody) > MAX_WEBHOOK_BYTES) throw new ApiError(413, "request_too_large", "The request is too large.");

    const channel = createTwilioChannel({ accountSid: "", authToken, from: "" });
    const url = `${appOrigin()}${new URL(request.url).pathname}`;
    let parsed: ReturnType<typeof channel.parseWebhook>;
    try {
      parsed = channel.parseWebhook({ rawBody, headers: request.headers, url });
    } catch (error) {
      if (error instanceof WebhookSignatureError) {
        return Response.json({ error: { code: "unauthorized" } }, { status: 401, headers: noStore });
      }
      throw error;
    }
    const result = await intakeStatuses("sms", parsed.statuses);
    return Response.json({ data: { queued: result.queued } }, { status: 200, headers: noStore });
  } catch (error: unknown) {
    return routeErrorResponse(error, "webhooks.twilio", requestId);
  }
}
