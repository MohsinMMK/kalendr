import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { applyFeatureLimits, loadStaffBusinessProfile } from "@/server/business-profile";
import { saveSeries } from "@/server/series";
import { seriesSaveSchema } from "@/server/series-contracts";
import { getStaffContext, requirePermission } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Books a whole repeating series in one transaction. When a visit cannot be saved, nothing is saved and the fresh list comes back with 409. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const idempotencyKey = getIdempotencyKey(request);
    const body = await parseJsonBody(request, seriesSaveSchema);
    const context = await getStaffContext(request.headers, body.booking.clinicSlug);
    requirePermission(context, "series.manage");
    const booking = applyFeatureLimits(body.booking, await loadStaffBusinessProfile(context));
    const result = await saveSeries(context, { ...body, booking }, idempotencyKey);
    return dataResponse(result, result.saved ? 201 : 409);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.series.create", requestId);
  }
}
