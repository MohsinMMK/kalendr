import { z } from "zod";

import { updateAppointmentStatus } from "@/server/appointment-repository";
import { ApiError } from "@/server/api-error";
import { staffAppointmentStatusSchema } from "@/server/contracts";
import {
  dataResponse,
  parseJsonBody,
  routeErrorResponse,
} from "@/server/http";
import { getStaffContext, requirePermission } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const appointmentIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

interface StatusRouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(
  request: Request,
  context: StatusRouteContext,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    requirePermission(staff, "appointments.status");
    if (!staff.userId) {
      throw new ApiError(401, "unauthorized", "Sign in is required.");
    }
    const { id } = await context.params;
    const appointmentId = appointmentIdSchema.safeParse(id);
    if (!appointmentId.success) {
      throw new ApiError(404, "appointment_not_found", "Appointment not found.");
    }
    const input = await parseJsonBody(request, staffAppointmentStatusSchema);
    const result = await updateAppointmentStatus(
      staff.userId,
      appointmentId.data,
      input,
      undefined,
      { locationIds: staff.locationIds },
    );
    return dataResponse({
      appointmentId: result.appointmentId,
      status: result.status,
      version: result.version,
    });
  } catch (error) {
    return routeErrorResponse(error, "staff.appointment.status", requestId);
  }
}
