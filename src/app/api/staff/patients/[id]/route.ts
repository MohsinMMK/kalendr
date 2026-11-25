import { profileWords } from "@/lib/terminology";
import { ApiError } from "@/server/api-error";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { getStaffContext, requirePermission } from "@/server/staff-context";
import { staffPatientUpdateInput, updateStaffPatient } from "@/server/staff-operations";
import { applyFeatureLimits, loadStaffBusinessProfile } from "@/server/business-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    requirePermission(context, "appointments.book");
    const { id } = await params;
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) {
      throw new ApiError(404, "patient_not_found", `${profileWords(await loadStaffBusinessProfile(context)).Customer} not found.`);
    }
    const input = applyFeatureLimits(await parseJsonBody(request, staffPatientUpdateInput), await loadStaffBusinessProfile(context));
    return dataResponse(await updateStaffPatient(context, id, input));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.patient.update", requestId);
  }
}
