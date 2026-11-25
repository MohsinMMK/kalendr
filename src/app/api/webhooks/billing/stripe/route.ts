import { ApiError } from "@/server/api-error";
import { extractStripeEvent, MAX_BILLING_WEBHOOK_BYTES, verifyStripeSignature } from "@/server/billing/webhook-events";
import { intakeBillingEvent } from "@/server/billing/webhook-intake";
import { env } from "@/server/env";
import { routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
const unauthorized = () => Response.json({ error: { code: "unauthorized" } }, { status: 401, headers: noStore });

/**
 * Stripe subscription events for Kalendr's own plans (not customer payments). Five steps in order: read the raw
 * body; verify `Stripe-Signature` (HMAC-SHA256 over timestamp and body, five-minute tolerance, constant-time compare;
 * 401 with no detail on failure or when no secret is set); find the business and record the event once; queue the
 * worker's job in the same transaction; answer 200 at once.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const secret = env().STRIPE_WEBHOOK_SECRET;
    if (!secret) return unauthorized();
    if (Number(request.headers.get("content-length") ?? "0") > MAX_BILLING_WEBHOOK_BYTES) throw new ApiError(413, "request_too_large", "The request is too large.");
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody) > MAX_BILLING_WEBHOOK_BYTES) throw new ApiError(413, "request_too_large", "The request is too large.");
    if (!verifyStripeSignature(rawBody, request.headers.get("stripe-signature"), secret)) return unauthorized();

    const extract = extractStripeEvent(rawBody);
    const result = extract ? await intakeBillingEvent(extract) : "dropped";
    return Response.json({ data: { result } }, { status: 200, headers: noStore });
  } catch (error: unknown) {
    return routeErrorResponse(error, "webhooks.stripe", requestId);
  }
}
