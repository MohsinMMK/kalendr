import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { loadAppointmentFormAnswers } from "@/server/booking-forms";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const appointmentIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

/** The booking form answers for one appointment, or null. Any staff member who can see the appointment may read them. */
export async function GET(request: Request, route: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    const id = appointmentIdSchema.safeParse((await route.params).id);
    if (!id.success) throw new ApiError(404, "appointment_not_found", "Appointment not found.");
    return dataResponse(await loadAppointmentFormAnswers(context, id.data));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.appointment.form", requestId);
  }
}
