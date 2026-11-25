import { bookingLimitsQuerySchema, bookingLimitsReplaceSchema } from "@/lib/booking-limits";
import { getBookingLimits, listLimitTeams, replaceBookingLimits } from "@/server/booking-limits-admin";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { ApiError } from "@/server/api-error";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `?scope=service&scopeId=…` for one owner's limits, or `?scope=team` for every team pool. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    const parsed = bookingLimitsQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()));
    if (!parsed.success) throw new ApiError(400, "validation_error", "Say which limits you want to see.");
    if (parsed.data.scope === "team" && !parsed.data.scopeId) return dataResponse(await listLimitTeams(context));
    if (!parsed.data.scopeId) throw new ApiError(400, "validation_error", "Say which limits you want to see.", { scopeId: ["Choose what the limits are for."] });
    return dataResponse(await getBookingLimits(context, parsed.data.scope, parsed.data.scopeId));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.limits.read", requestId);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await replaceBookingLimits(context, await parseJsonBody(request, bookingLimitsReplaceSchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.limits.save", requestId);
  }
}
