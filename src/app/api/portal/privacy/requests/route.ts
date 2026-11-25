import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { requireFreshPatientSession, requirePatientAccount } from "@/server/patient-auth";
import { createPortalRequest, portalRequestInputSchema } from "@/server/privacy/portal";
import { FRESH_CODE_MINUTES } from "@/server/privacy/rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Asks for a download, an erasure or a correction. A download or an erasure needs a sign-in code entered in the last
 * 15 minutes. Asking again while a request of the same kind is open returns that request (200, `created: false`).
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const account = await requirePatientAccount(request.headers);
    await enforceLimit(request, "privacy_request.account", account.id);
    const input = await parseJsonBody(request, portalRequestInputSchema);
    if (input.type !== "correction") await requireFreshPatientSession(request.headers, FRESH_CODE_MINUTES);
    const result = await createPortalRequest(account, input);
    return dataResponse(result, result.created ? 201 : 200);
  } catch (error: unknown) {
    return routeErrorResponse(error, "portal.privacy.request", requestId);
  }
}
