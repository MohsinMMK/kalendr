import { z } from "zod";

import { runStaffAppointmentAction } from "@/server/staff-transitions";
import { ApiError } from "@/server/api-error";
import { staffAppointmentMutationSchema } from "@/server/contracts";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext, requirePermission } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const appointmentIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const { id } = await context.params;
    const appointmentId = appointmentIdSchema.safeParse(id);
    if (!appointmentId.success) {
      throw new ApiError(404, "appointment_not_found", "Appointment not found.");
    }
    const input = await parseJsonBody(request, staffAppointmentMutationSchema);
    // Moving a visit is booking work; marking the intake form received is part of running the visit.
    requirePermission(staff, input.action === "form_received" || input.action === "start" || input.action === "details" || input.action === "mark_no_show" ? "appointments.status" : "appointments.book");
    return dataResponse(await runStaffAppointmentAction(staff, appointmentId.data, input));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.appointment.mutate", requestId);
  }
}
