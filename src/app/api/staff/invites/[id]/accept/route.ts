import { NextResponse } from "next/server";

import { activeBusinessCookie, activeBusinessCookieMaxAge } from "@/lib/active-business";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { requireSessionUserId } from "@/server/staff-businesses";
import { acceptLoginInvite } from "@/server/staff-login-invites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The signed-in person accepts a business's invite to their own login. Session-only, like switching business: the invite is
 * the caller's own, and the business they join opens next (its policy, such as a second factor, is checked when it loads).
 * A platform operator's session never has invites, so a support session can't accept one for anybody.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const userId = await requireSessionUserId(request.headers);
    const { id } = await params;
    const business = await acceptLoginInvite(userId, id);
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
    return routeErrorResponse(error, "staff.invite.accept", requestId);
  }
}
