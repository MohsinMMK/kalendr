import "server-only";

import type { PaymentProviderId } from "@/lib/payments";

import { routeErrorResponse } from "../http";
import { receiveWebhook, readRawBody } from "./webhook";
import { WebhookSignatureError } from "./types";

const noStore = { "Cache-Control": "no-store" };

/** The shared body of the three webhook routes: 401 with no detail for any signature problem, 200 for everything we accepted. */
export async function providerWebhookResponse(provider: PaymentProviderId, publicId: string | null, request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const rawBody = await readRawBody(request);
    const result = await receiveWebhook(provider, publicId, rawBody, request.headers);
    return Response.json({ data: { result } }, { status: 200, headers: noStore });
  } catch (error: unknown) {
    if (error instanceof WebhookSignatureError) return Response.json({ error: { code: "unauthorized" } }, { status: 401, headers: noStore });
    return routeErrorResponse(error, `webhooks.${provider}`, requestId);
  }
}
