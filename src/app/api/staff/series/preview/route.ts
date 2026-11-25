import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { applyFeatureLimits, loadStaffBusinessProfile } from "@/server/business-profile";
import { previewSeries } from "@/server/series";
import { seriesPreviewSchema } from "@/server/series-contracts";
import { getStaffContext, requirePermission } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Checks every visit a rule would book and returns each as free or clashing, with other times that day. Saves nothing. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const body = await parseJsonBody(request, seriesPreviewSchema);
    const context = await getStaffContext(request.headers, body.booking.clinicSlug);
    requirePermission(context, "series.manage");
    const booking = applyFeatureLimits(body.booking, await loadStaffBusinessProfile(context));
    return dataResponse(await previewSeries(context, booking, body.rule));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.series.preview", requestId);
  }
}
