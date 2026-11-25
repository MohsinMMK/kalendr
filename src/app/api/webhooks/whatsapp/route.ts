import { ApiError } from "@/server/api-error";
import { answerVerification, createWhatsAppChannel } from "@/server/channels/whatsapp-cloud";
import { intakeStatuses } from "@/server/channels/webhook-intake";
import { applyTemplateStatuses, intakeInbound } from "@/server/channels/whatsapp-intake";
import { WebhookSignatureError } from "@/server/channels/types";
import { env } from "@/server/env";
import { routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
const MAX_BYTES = 256 * 1024;
const unauthorized = () => Response.json({ error: { code: "unauthorized" } }, { status: 401, headers: noStore });

/** Meta's one-time address check. Echoes the challenge only when the verify token matches. */
export async function GET(request: Request): Promise<Response> {
  const challenge = answerVerification(new URL(request.url).searchParams, env().WHATSAPP_VERIFY_TOKEN);
  if (challenge === null) return new Response("Forbidden", { status: 403, headers: noStore });
  return new Response(challenge, { status: 200, headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" } });
}

/**
 * Message statuses, customer replies and template approvals from Meta. The signature is checked over
 * the raw body before anything is parsed. Each status or reply is queued once (a repeat is a no-op),
 * and the worker acts on it. A 200 follows even for messages we don't know, so Meta stops retrying.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const settings = env();
    if (!settings.WHATSAPP_APP_SECRET) return unauthorized();
    if (Number(request.headers.get("content-length") ?? "0") > MAX_BYTES) throw new ApiError(413, "request_too_large", "The request is too large.");
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody) > MAX_BYTES) throw new ApiError(413, "request_too_large", "The request is too large.");

    const channel = createWhatsAppChannel({ accessToken: "-", phoneNumberId: "-", appSecret: settings.WHATSAPP_APP_SECRET });
    let parsed: ReturnType<typeof channel.parseWebhook>;
    try {
      parsed = channel.parseWebhook({ rawBody, headers: request.headers, url: request.url });
    } catch (error) {
      if (error instanceof WebhookSignatureError) return unauthorized();
      throw error;
    }
    const statuses = await intakeStatuses("whatsapp", parsed.statuses);
    const inbound = await intakeInbound(parsed.inbound);
    await applyTemplateStatuses(parsed.templates);
    return Response.json({ data: { statuses, inbound } }, { status: 200, headers: noStore });
  } catch (error: unknown) {
    return routeErrorResponse(error, "webhooks.whatsapp", requestId);
  }
}
