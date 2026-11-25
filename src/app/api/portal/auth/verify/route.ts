import { portalCodeVerifySchema } from "@/server/contracts";
import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { sessionCookieHeader, verifyLoginCode } from "@/server/patient-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "code_verify.ip");
    const input = await parseJsonBody(request, portalCodeVerifySchema);
    const grant = await verifyLoginCode(input.kind, input.contact, input.code, { remember: input.remember, userAgent: request.headers.get("user-agent") });
    const response = dataResponse({ signedIn: true });
    response.headers.append("Set-Cookie", sessionCookieHeader(grant));
    return response;
  } catch (error: unknown) {
    return routeErrorResponse(error, "portal.code.verify", requestId);
  }
}
