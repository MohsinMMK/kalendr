import { dataResponse, routeErrorResponse } from "@/server/http";
import { requirePatientAccount } from "@/server/patient-auth";
import { getPortalSnapshot } from "@/server/patient-portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await getPortalSnapshot(await requirePatientAccount(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "portal.snapshot", requestId);
  }
}
