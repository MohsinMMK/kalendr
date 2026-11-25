import { lookupCompanySignIn, ssoLookupSchema } from "@/server/enterprise/sso-flow";
import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public. Whether an email address's company has company sign-in. Rate limited by network. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "sso.ip");
    const input = await parseJsonBody(request, ssoLookupSchema);
    return dataResponse(await lookupCompanySignIn(input.email));
  } catch (error: unknown) {
    return routeErrorResponse(error, "sso.lookup", requestId);
  }
}
