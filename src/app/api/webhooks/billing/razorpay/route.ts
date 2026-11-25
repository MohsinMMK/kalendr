import { ApiError } from "@/server/api-error";
import { extractRazorpayEvent, MAX_BILLING_WEBHOOK_BYTES, verifyRazorpaySignature } from "@/server/billing/webhook-events";
import { intakeBillingEvent } from "@/server/billing/webhook-intake";
import { env } from "@/server/env";
import { routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
const unauthorized = () => Response.json({ error: { code: "unauthorized" } }, { status: 401, headers: noStore });

/**
 * Razorpay subscription events for Kalendr's own plans (not customer payments). Five steps in order: read the raw
 * body; check the HMAC-SHA256 signature in constant time (401, no detail, when wrong or when no secret is set);
 * find the business and record the event once; queue the worker's job in the same transaction; answer 200 at once.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const secret = env().RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return unauthorized();
    if (Number(request.headers.get("content-length") ?? "0") > MAX_BILLING_WEBHOOK_BYTES) throw new ApiError(413, "request_too_large", "The request is too large.");
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody) > MAX_BILLING_WEBHOOK_BYTES) throw new ApiError(413, "request_too_large", "The request is too large.");
    if (!verifyRazorpaySignature(rawBody, request.headers.get("x-razorpay-signature"), secret)) return unauthorized();

    const extract = extractRazorpayEvent(rawBody, request.headers.get("x-razorpay-event-id"));
    // A signed body we cannot read is still a 200: a retry would fail the same way.
    const result = extract ? await intakeBillingEvent(extract) : "dropped";
    return Response.json({ data: { result } }, { status: 200, headers: noStore });
  } catch (error: unknown) {
    return routeErrorResponse(error, "webhooks.razorpay", requestId);
  }
}
