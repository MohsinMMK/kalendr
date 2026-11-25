import { providerWebhookResponse } from "@/server/payments/webhook-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stripe Connect events from every connected account. The business is found from the event's account id. */
export async function POST(request: Request): Promise<Response> {
  return providerWebhookResponse("stripe", null, request);
}
