import { z } from "zod";

import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { appOrigin } from "@/server/payments/accounts";
import { startLinkCheckout } from "@/server/payments/checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.strictObject({ token: z.string().trim().min(20).max(200) });

/** The checkout for a pay link a staff member sent. The token is the booking's own manage token. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "payments.ip");
    const { token } = await parseJsonBody(request, bodySchema, { maxBytes: 2_000 });
    return dataResponse(await startLinkCheckout(token, appOrigin(request)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.bookings.pay_link", requestId);
  }
}
