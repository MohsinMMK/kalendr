import { paymentStatusSchema } from "@/lib/payments";
import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { paymentStatus } from "@/server/payments/checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The "confirming…" screen asks here. It only reports; the provider's webhook is what confirms a payment. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "payments.ip");
    return dataResponse(await paymentStatus(await parseJsonBody(request, paymentStatusSchema, { maxBytes: 2_000 })));
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.bookings.pay_status", requestId);
  }
}
