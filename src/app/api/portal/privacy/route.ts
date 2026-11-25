import { dataResponse, parseQuery, routeErrorResponse } from "@/server/http";
import { requirePatientAccount } from "@/server/patient-auth";
import { getPortalPrivacy, portalPrivacyQuerySchema } from "@/server/privacy/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The signed-in customer's choices, open requests and the privacy notice, for every business that holds their details. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const account = await requirePatientAccount(request.headers);
    const query = parseQuery(request, portalPrivacyQuerySchema);
    return dataResponse(await getPortalPrivacy(account, query.language));
  } catch (error: unknown) {
    return routeErrorResponse(error, "portal.privacy.get", requestId);
  }
}
