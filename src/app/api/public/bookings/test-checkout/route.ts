import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { fakeProviderAllowed } from "@/server/payments/fake";
import { appOrigin } from "@/server/payments/accounts";
import { completeTestCheckout, testCheckoutSchema } from "@/server/payments/test-checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The test checkout's buttons. Sends a signed webhook to our own route, like a provider. Answers 404 in production. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    if (!fakeProviderAllowed()) return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
    await enforceLimit(request, "payments.ip");
    return dataResponse(await completeTestCheckout(await parseJsonBody(request, testCheckoutSchema, { maxBytes: 2_000 }), appOrigin(request)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.bookings.test_checkout", requestId);
  }
}
