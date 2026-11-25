import { validateCouponInputSchema } from "@/lib/offers-contracts";
import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { validateCouponPublic } from "@/server/offers/coupons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The booking page's code check. One answer for a wrong, expired or used-up code, tightly rate-limited so codes cannot be guessed.
 * The rules that depend on who is booking are enforced when the booking is made, not here.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "coupon_validate.ip");
    return dataResponse(await validateCouponPublic(await parseJsonBody(request, validateCouponInputSchema, { maxBytes: 1_000 })));
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.coupons.validate", requestId);
  }
}
