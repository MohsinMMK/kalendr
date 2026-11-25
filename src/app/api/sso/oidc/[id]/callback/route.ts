import { NextResponse } from "next/server";

import { absolute, finishOidcSignIn } from "@/server/enterprise/sso-flow";
import { enforceLimit, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public. The provider sends the browser back here with a code; it is checked and traded for a one-time ticket. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "sso.ip");
    const { id } = await params;
    return NextResponse.redirect(absolute(await finishOidcSignIn(id, new URL(request.url))), 303);
  } catch (error: unknown) {
    return routeErrorResponse(error, "sso.oidc.callback", requestId);
  }
}
