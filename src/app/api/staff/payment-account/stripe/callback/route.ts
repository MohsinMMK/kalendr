import { NextResponse } from "next/server";

import { logger } from "@/server/logger";
import { appOrigin } from "@/server/payments/accounts";
import { finishStripeConnect, STRIPE_STATE_COOKIE } from "@/server/payments/stripe-connect";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Where Stripe sends the owner back. Whatever happens, they land on the settings page; nothing from Stripe is shown. */
export async function GET(request: Request): Promise<Response> {
  const origin = appOrigin(request);
  const params = new URL(request.url).searchParams;
  const cookie = request.headers.get("cookie")?.split(/;\s*/).find((part) => part.startsWith(`${STRIPE_STATE_COOKIE}=`))?.slice(STRIPE_STATE_COOKIE.length + 1) ?? null;
  let outcome = "stripe_failed";
  try {
    const code = params.get("code");
    if (code && !params.get("error")) {
      await finishStripeConnect(await getStaffContext(request.headers), { code, state: params.get("state"), cookieNonce: cookie }, origin);
      outcome = "stripe_connected";
    }
  } catch (error: unknown) {
    logger().warn({ event: "payments.stripe_connect_failed", code: typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "unknown" }, "Connecting Stripe failed");
  }
  const response = NextResponse.redirect(`${origin}/settings?payments=${outcome}`);
  response.cookies.delete({ name: STRIPE_STATE_COOKIE, path: "/api/staff/payment-account/stripe" });
  return response;
}
