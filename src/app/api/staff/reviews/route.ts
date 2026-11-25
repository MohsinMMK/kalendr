import { z } from "zod";

import { dataResponse, parseQuery, routeErrorResponse } from "@/server/http";
import { listAppointmentRatings, listStaffReviews } from "@/server/reviews";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  appointmentId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/).optional(),
  patientId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/).optional(),
});

/**
 * Every review of the business, hidden and private ones too, newest first. With `appointmentId` or `patientId` it is instead
 * the rating on that appointment or customer, for the appointment screen and the customer profile.
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    const filter = parseQuery(request, querySchema);
    if (filter.appointmentId || filter.patientId) return dataResponse(await listAppointmentRatings(context, filter));
    return dataResponse(await listStaffReviews(context));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.review.list", requestId);
  }
}
