import { staffSelfUpdateSchema } from "@/server/contracts";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { updateOwnProfile } from "@/server/staff-team";
import { rescheduleAffectedAppointments } from "@/server/timing-automation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who is signed in and, while an operator is viewing as this business, the banner's data (feature 15). */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    return dataResponse({ role: staff.role, clinicName: staff.clinicName, impersonation: staff.impersonation ?? null });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.me.read", requestId);
  }
}

/** My profile: a person changes their own name, doctor profile and, when allowed, working hours. */
export async function PATCH(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const input = await parseJsonBody(request, staffSelfUpdateSchema, { maxBytes: 160 * 1_024 });
    const result = await updateOwnProfile(staff, input);
    return dataResponse({
      ...result,
      // Same as an owner changing their hours: visits that no longer fit are moved or flagged.
      timing: input.hours && result.practitionerId
        ? await rescheduleAffectedAppointments(staff, result.practitionerId)
        : { moved: [], unresolved: [] },
    });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.me.update", requestId);
  }
}
