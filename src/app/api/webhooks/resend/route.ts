import { ApiError } from "@/server/api-error";
import { env } from "@/server/env";
import { routeErrorResponse } from "@/server/http";
import { applyResendEvent, MAX_WEBHOOK_BYTES, verifyResendWebhook, WebhookSignatureError } from "@/server/messaging/resend-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/**
 * Resend delivery events. The signature is checked over the raw body before anything is
 * parsed; a bad or missing signature, or no secret configured, is a 401 with no detail.
 * A duplicate or an event for a message we don't know is still a 200, so Resend stops retrying.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const secret = env().RESEND_WEBHOOK_SECRET;
    if (!secret) return Response.json({ error: { code: "unauthorized" } }, { status: 401, headers: noStore });

    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_WEBHOOK_BYTES) throw new ApiError(413, "request_too_large", "The request is too large.");
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody) > MAX_WEBHOOK_BYTES) throw new ApiError(413, "request_too_large", "The request is too large.");

    let verified: ReturnType<typeof verifyResendWebhook>;
    try {
      verified = verifyResendWebhook(secret, rawBody, request.headers);
    } catch (error) {
      if (error instanceof WebhookSignatureError) {
        return Response.json({ error: { code: "unauthorized" } }, { status: 401, headers: noStore });
      }
      throw error;
    }

    const result = await applyResendEvent(verified.eventId, verified.event);
    return Response.json({ data: { result } }, { status: 200, headers: noStore });
  } catch (error: unknown) {
    return routeErrorResponse(error, "webhooks.resend", requestId);
  }
}
