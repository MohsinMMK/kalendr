
import { ApiError } from "@/server/api-error";
import { appointmentTokenSchemaFor } from "@/server/manage-route";
import { stepUpRequestSchema } from "@/server/contracts";
import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { requestStepUp, requireLiveManageLink } from "@/server/patient-step-up";
import { resolveManageToken } from "@/server/appointment-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sends the one-time code for a manage link. The limits are separate from sign-in codes: they count per booking and per network. */
export async function POST(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const token = appointmentTokenSchemaFor((await context.params).token);
    await requireLiveManageLink(token);
    await enforceLimit(request, "step_up.ip");
    const input = await parseJsonBody(request, stepUpRequestSchema);
    const resolved = await resolveManageToken(token);
    if (!resolved) throw new ApiError(404, "appointment_not_found", "Appointment not found.");
    await enforceLimit(request, "step_up.appointment", `${resolved.tenant_id}:${resolved.appointment_id}`);
    return dataResponse(await requestStepUp(token, input.action), 202);
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.appointment.step_up", requestId);
  }
}

