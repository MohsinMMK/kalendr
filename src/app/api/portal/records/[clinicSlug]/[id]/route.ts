import { dataResponse, routeErrorResponse } from "@/server/http";
import { requirePatientAccount } from "@/server/patient-auth";
import { getPortalRecord } from "@/server/patient-portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ clinicSlug: string; id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const { clinicSlug, id } = await context.params;
    return dataResponse(await getPortalRecord(await requirePatientAccount(request.headers), clinicSlug, id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "portal.record.read", requestId);
  }
}
