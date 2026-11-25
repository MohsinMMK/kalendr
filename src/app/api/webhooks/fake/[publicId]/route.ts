import { fakeProviderAllowed } from "@/server/payments/fake";
import { providerWebhookResponse } from "@/server/payments/webhook-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The built-in test provider's events. Not served in production. */
export async function POST(request: Request, context: { params: Promise<{ publicId: string }> }): Promise<Response> {
  if (!fakeProviderAllowed()) return Response.json({ error: { code: "not_found" } }, { status: 404 });
  return providerWebhookResponse("fake", (await context.params).publicId, request);
}
