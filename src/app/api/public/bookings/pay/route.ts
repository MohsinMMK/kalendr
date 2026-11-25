import { startPaymentSchema } from "@/lib/payments";
import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { appOrigin } from "@/server/payments/accounts";
import { startCheckout } from "@/server/payments/checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Starts the provider's checkout for a booking that is waiting for payment. The amount is worked out on the server. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "payments.ip");
    return dataResponse(await startCheckout(await parseJsonBody(request, startPaymentSchema, { maxBytes: 2_000 }), appOrigin(request)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.bookings.pay", requestId);
  }
}
