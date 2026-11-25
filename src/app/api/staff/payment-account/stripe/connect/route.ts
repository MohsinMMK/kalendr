import { NextResponse } from "next/server";

import { routeErrorResponse } from "@/server/http";
import { appOrigin } from "@/server/payments/accounts";
import { startStripeConnect, STRIPE_STATE_COOKIE } from "@/server/payments/stripe-connect";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sends the signed-in owner to Stripe to connect their own account. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const started = startStripeConnect(await getStaffContext(request.headers), appOrigin(request));
    const response = NextResponse.redirect(started.url);
    response.cookies.set(STRIPE_STATE_COOKIE, started.nonce, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 600, path: "/api/staff/payment-account/stripe" });
    return response;
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.payment_account.stripe_connect", requestId);
  }
}
