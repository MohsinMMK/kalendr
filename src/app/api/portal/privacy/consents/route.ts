import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { requirePatientAccount } from "@/server/patient-auth";
import { portalConsentInputSchema, setPortalConsent } from "@/server/privacy/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One purpose, one switch: grants or withdraws it for one customer. Saying what is already true changes nothing. */
export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const account = await requirePatientAccount(request.headers);
    await enforceLimit(request, "privacy_portal.account", account.id);
    const input = await parseJsonBody(request, portalConsentInputSchema);
    return dataResponse(await setPortalConsent(account, input));
  } catch (error: unknown) {
    return routeErrorResponse(error, "portal.privacy.consent", requestId);
  }
}
