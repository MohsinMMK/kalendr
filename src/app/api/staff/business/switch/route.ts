import { NextResponse } from "next/server";

import { activeBusinessCookie, activeBusinessCookieMaxAge, switchBusinessSchema } from "@/lib/active-business";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { requireOwnBusiness, requireSessionUserId } from "@/server/staff-businesses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Opens another business the signed-in person works in. It checks the session and the membership only, not the business
 * policy of the one they are leaving or entering: that is checked when the next page loads, so a business that wants a
 * second factor blocks itself and nothing else.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const userId = await requireSessionUserId(request.headers);
    const input = await parseJsonBody(request, switchBusinessSchema);
    const business = await requireOwnBusiness(userId, input.slug);
    const reply = dataResponse({ slug: business.slug, name: business.name });
    const response = new NextResponse(reply.body, { status: reply.status, headers: reply.headers });
    response.cookies.set(activeBusinessCookie, business.slug, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: activeBusinessCookieMaxAge,
      path: "/",
    });
    return response;
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.business.switch", requestId);
  }
}
