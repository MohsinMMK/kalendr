import { afterBookingRedirect, afterBookingRequestSchema } from "@/server/after-booking";
import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The booking page asks, right after a booking, whether to send the customer to the business's own thank-you page. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "booking_redirect.ip");
    const input = await parseJsonBody(request, afterBookingRequestSchema);
    return dataResponse(await afterBookingRedirect(input.manageToken));
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.booking_redirect", requestId);
  }
}
