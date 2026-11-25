import { profileWords } from "@/lib/terminology";
import { ApiError } from "@/server/api-error";
import { listAvailability } from "@/server/appointment-repository";
import { loadStaffBusinessProfile } from "@/server/business-profile";
import { availabilityQuerySchema } from "@/server/contracts";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { getStaffContext, requirePermission } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Openings for the front desk. With `walkIn=1` it lists starts from 15 minutes ago up to
 * 12 hours ahead and ignores the online lead time, so someone standing at the desk can be seen now.
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    requirePermission(context, "appointments.book");
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    const { walkIn, ...query } = params;
    const parsed = availabilityQuerySchema.safeParse(query);
    if (!parsed.success) throw new ApiError(400, "validation_error", "The availability request is invalid.");
    if (parsed.data.clinicSlug !== context.clinicSlug) {
      throw new ApiError(404, "clinic_not_found", `${profileWords(await loadStaffBusinessProfile(context)).Business} not found.`);
    }
    const slots = await listAvailability(parsed.data, { walkIn: walkIn === "1" });
    return dataResponse({ slots });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.availability", requestId);
  }
}
