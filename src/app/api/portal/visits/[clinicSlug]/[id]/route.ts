import { getPortalManageSnapshot, managePortalAppointment } from "@/server/appointment-repository";
import { manageAppointmentActionSchema } from "@/server/contracts";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { requirePatientAccount } from "@/server/patient-auth";
import { resolvePortalVisit } from "@/server/patient-portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ clinicSlug: string; id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const { clinicSlug, id } = await context.params;
    const visit = await resolvePortalVisit(await requirePatientAccount(request.headers), clinicSlug, id);
    return dataResponse(await getPortalManageSnapshot(visit.tenantId, visit.appointmentId));
  } catch (error: unknown) {
    return routeErrorResponse(error, "portal.visit.read", requestId);
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const { clinicSlug, id } = await context.params;
    const account = await requirePatientAccount(request.headers);
    const visit = await resolvePortalVisit(account, clinicSlug, id);
    const input = await parseJsonBody(request, manageAppointmentActionSchema);
    return dataResponse(await managePortalAppointment(visit.tenantId, visit.appointmentId, input, account.id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "portal.visit.manage", requestId);
  }
}
