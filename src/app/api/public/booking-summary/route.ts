import { z } from "zod";

import { checkSummaryToken } from "@/server/after-booking";
import { dataResponse, enforceLimit, parseQuery, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({ token: z.string().min(20).max(600) });

/** A thank-you page sends back the `kalendr_token` it was given; the answer is the booking id, service id and start time. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "booking_redirect.ip");
    const { token } = parseQuery(request, querySchema);
    return dataResponse(checkSummaryToken(token));
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.booking_summary", requestId);
  }
}
