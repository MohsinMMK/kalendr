import { providerWebhookResponse } from "@/server/payments/webhook-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Razorpay events for one business. The address holds an unguessable id; the signature is the real proof. */
export async function POST(request: Request, context: { params: Promise<{ publicId: string }> }): Promise<Response> {
  return providerWebhookResponse("razorpay", (await context.params).publicId, request);
}
