import { appointmentTokenSchemaFor } from "@/server/manage-route";
import { stepUpVerifySchema } from "@/server/contracts";
import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { requireLiveManageLink, stepUpCookieHeader, verifyStepUp } from "@/server/patient-step-up";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const token = appointmentTokenSchemaFor((await context.params).token);
    await requireLiveManageLink(token);
    await enforceLimit(request, "step_up_verify.ip");
    const input = await parseJsonBody(request, stepUpVerifySchema);
    const { grant } = await verifyStepUp(token, input.code);
    const response = dataResponse({ verified: true });
    response.headers.append("Set-Cookie", stepUpCookieHeader(grant));
    return response;
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.appointment.step_up_verify", requestId);
  }
}
