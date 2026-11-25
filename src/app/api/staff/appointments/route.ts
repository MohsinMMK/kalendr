import { createStaffAppointment } from "@/server/appointment-repository";
import { staffBookingSchema } from "@/server/contracts";
import { canonicalJsonHash } from "@/server/crypto";
import {
  dataResponse,
  getIdempotencyKey,
  parseJsonBody,
  routeErrorResponse,
} from "@/server/http";
import { getStaffContext, requirePermission } from "@/server/staff-context";
import { applyFeatureLimits, loadStaffBusinessProfile } from "@/server/business-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const idempotencyKey = getIdempotencyKey(request);
    const body = await parseJsonBody(request, staffBookingSchema);
    const context = await getStaffContext(request.headers, body.clinicSlug);
    requirePermission(context, "appointments.book");
    const input = applyFeatureLimits(body, await loadStaffBusinessProfile(context));
    const result = await createStaffAppointment(
      context,
      input,
      idempotencyKey,
      canonicalJsonHash(input),
    );
    return dataResponse(result, 201);
  } catch (error) {
    return routeErrorResponse(error, "staff.appointment.create", requestId);
  }
}
