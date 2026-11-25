import { appointmentTokenSchemaFor } from "@/server/manage-route";
import { changeBookingContact } from "@/server/booking-contact";
import { bookingContactChangeSchema } from "@/server/contracts";
import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { finishStepUp, requireLiveManageLink, requireStepUp } from "@/server/patient-step-up";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Changes the phone or email on the booking. Needs the one-time code, like cancelling does. */
export async function PATCH(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const token = appointmentTokenSchemaFor((await context.params).token);
    await requireLiveManageLink(token);
    await enforceLimit(request, "manage_link.token", token);
    const input = await parseJsonBody(request, bookingContactChangeSchema);
    const stepUp = await requireStepUp(request.headers, token);
    const result = await changeBookingContact(token, input);
    await finishStepUp(stepUp);
    return dataResponse(result);
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.appointment.contact", requestId);
  }
}
