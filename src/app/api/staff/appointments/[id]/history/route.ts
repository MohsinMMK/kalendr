import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { getBookingHistory } from "@/server/booking-history";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const appointmentIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    const id = appointmentIdSchema.safeParse((await context.params).id);
    if (!id.success) throw new ApiError(404, "appointment_not_found", "Appointment not found.");
    return dataResponse(await getBookingHistory(staff, id.data));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.appointment.history", requestId);
  }
}
