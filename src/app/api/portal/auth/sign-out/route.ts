import { dataResponse, routeErrorResponse } from "@/server/http";
import { clearedSessionCookieHeader, endPatientSession } from "@/server/patient-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await endPatientSession(request.headers);
    const response = dataResponse({ signedOut: true });
    response.headers.append("Set-Cookie", clearedSessionCookieHeader());
    return response;
  } catch (error: unknown) {
    return routeErrorResponse(error, "portal.sign_out", requestId);
  }
}
