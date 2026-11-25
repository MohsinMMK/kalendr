import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { loadOnboardingState, stepActionSchema, updateStep } from "@/server/onboarding/progress";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The first-run checklist, the tour state and the go-live check. `null` in the preview, which has no checklist. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await loadOnboardingState(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.onboarding.read", requestId);
  }
}

/** Ticks off, skips or un-skips one step. Doing the same thing again changes nothing. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await updateStep(context, await parseJsonBody(request, stepActionSchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.onboarding.step", requestId);
  }
}
