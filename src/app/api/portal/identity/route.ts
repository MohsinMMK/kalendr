import { portalIdentitySchema } from "@/server/contracts";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { requirePatientAccount } from "@/server/patient-auth";
import { confirmPortalIdentity, requestPortalConfirmation } from "@/server/patient-portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** With a date of birth: proves identity. Without one: asks the clinic to confirm it instead. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const account = await requirePatientAccount(request.headers);
    const input = await parseJsonBody(request, portalIdentitySchema);
    if (input.dateOfBirth) await confirmPortalIdentity(account, input.clinicSlug, input.patientId, input.dateOfBirth);
    else await requestPortalConfirmation(account, input.clinicSlug, input.patientId);
    return dataResponse({ ok: true });
  } catch (error: unknown) {
    return routeErrorResponse(error, "portal.identity", requestId);
  }
}
