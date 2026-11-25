import { staffUpdatePractitionerSchema } from "@/server/contracts";
import { parseJsonBody, dataResponse, routeErrorResponse } from "@/server/http";
import { can, getStaffContext, requirePermission } from "@/server/staff-context";
import { updateStaffPractitioner } from "@/server/staff-team";
import { rescheduleAffectedAppointments } from "@/server/timing-automation";
import { applyFeatureLimits, loadStaffBusinessProfile } from "@/server/business-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    // Hours-only edits need "hours.edit"; anything else needs "team.manage". Checked again inside.
    if (!can(staff, "hours.edit")) requirePermission(staff, "team.manage");
    const { id } = await context.params;
    const input = applyFeatureLimits(await parseJsonBody(request, staffUpdatePractitionerSchema, { maxBytes: 160 * 1_024 }), await loadStaffBusinessProfile(staff));
    return dataResponse({
      ...(await updateStaffPractitioner(staff, id, input)),
      // Runs after the new hours are saved, so every move is checked against them.
      timing: input.hours ? await rescheduleAffectedAppointments(staff, id) : { moved: [], unresolved: [] },
    });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.team.practitioner.update", requestId);
  }
}
