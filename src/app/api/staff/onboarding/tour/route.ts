import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { tourActionSchema, updateTour } from "@/server/onboarding/progress";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The tour was finished, closed part way, or is being opened again from Help. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { action } = await parseJsonBody(request, tourActionSchema);
    await updateTour(context, action);
    return dataResponse({ action });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.onboarding.tour", requestId);
  }
}
