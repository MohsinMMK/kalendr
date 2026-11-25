import { dataResponse, routeErrorResponse } from "@/server/http";
import { getPortalOffers } from "@/server/offers/portal";
import { requirePatientAccount } from "@/server/patient-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The customer's packages (balance and expiry) and memberships, for the portal. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await getPortalOffers(await requirePatientAccount(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "portal.offers", requestId);
  }
}
