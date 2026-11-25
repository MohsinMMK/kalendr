import { NextResponse } from "next/server";

import { absolute, browserCookieOptions, startCompanySignIn } from "@/server/enterprise/sso-flow";
import { newBrowserBinding, SSO_BROWSER_COOKIE } from "@/server/enterprise/sso-state";
import { enforceLimit, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public. Sends the browser to the company's identity provider. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "sso.ip");
    const { id } = await params;
    const browser = newBrowserBinding();
    const target = await startCompanySignIn("saml", id, browser.binding);
    // A provider address is absolute; a Kalendr path (an error) is not.
    const response = NextResponse.redirect(target.startsWith("/") ? absolute(target) : target, 303);
    response.cookies.set(SSO_BROWSER_COOKIE, browser.cookie, browserCookieOptions());
    return response;
  } catch (error: unknown) {
    return routeErrorResponse(error, "sso.saml.start", requestId);
  }
}
