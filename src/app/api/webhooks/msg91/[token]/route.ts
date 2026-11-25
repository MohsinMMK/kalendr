import { timingSafeEqual } from "node:crypto";

import { createMsg91Channel } from "@/server/channels/sms-msg91";
import { intakeStatuses } from "@/server/channels/webhook-intake";
import { WebhookSignatureError } from "@/server/channels/types";
import { ApiError } from "@/server/api-error";
import { env } from "@/server/env";
import { routeErrorResponse } from "@/server/http";
import { MAX_WEBHOOK_BYTES } from "@/server/messaging/resend-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

interface Msg91Context {
  params: Promise<{ token: string }>;
}

function sameToken(expected: string, received: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * MSG91 delivery reports. MSG91 does not sign them, so the secret in the address is the only
 * proof they come from MSG91: wrong or missing is a 401 with no detail. Once past that, the
 * answer is always 200 so MSG91 stops retrying.
 */
export async function POST(request: Request, context: Msg91Context): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const secret = env().MSG91_WEBHOOK_TOKEN;
    const { token } = await context.params;
    if (!secret || !sameToken(secret, token)) {
      return Response.json({ error: { code: "unauthorized" } }, { status: 401, headers: noStore });
    }
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_WEBHOOK_BYTES) throw new ApiError(413, "request_too_large", "The request is too large.");
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody) > MAX_WEBHOOK_BYTES) throw new ApiError(413, "request_too_large", "The request is too large.");

    // The channel only reads the reports here; it needs no credentials for that.
    const channel = createMsg91Channel({ authKey: "", senderId: "" });
    let parsed: ReturnType<typeof channel.parseWebhook>;
    try {
      parsed = channel.parseWebhook({ rawBody, headers: request.headers, url: request.url });
    } catch (error) {
      // A body we can't read is not worth a retry storm.
      if (error instanceof WebhookSignatureError) return Response.json({ data: { queued: 0 } }, { status: 200, headers: noStore });
      throw error;
    }
    const result = await intakeStatuses("sms", parsed.statuses);
    return Response.json({ data: { queued: result.queued } }, { status: 200, headers: noStore });
  } catch (error: unknown) {
    return routeErrorResponse(error, "webhooks.msg91", requestId);
  }
}
