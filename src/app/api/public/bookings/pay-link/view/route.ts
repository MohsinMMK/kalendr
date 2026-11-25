import { z } from "zod";

import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { viewPayLink } from "@/server/payments/checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.strictObject({ token: z.string().trim().min(20).max(200) });

/** What the pay page shows before Pay is tapped: the visit, the amount still owed, and the policy. No contact details. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "payments.ip");
    return dataResponse(await viewPayLink((await parseJsonBody(request, bodySchema, { maxBytes: 2_000 })).token));
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.bookings.pay_link_view", requestId);
  }
}
