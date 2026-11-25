import { oneResult, v1Route } from "@/server/api-v1";
import { cancelBody } from "@/server/api-v1-contracts";
import { pathId } from "@/server/api-v1-reads";
import { cancelAppointment } from "@/server/api-v1-writes";
import { parseJsonBody } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = v1Route("v1.appointments.cancel", "appointments:write", async ({ request, context, params }) => {
  const id = pathId(params.id, { code: "appointment_not_found", message: "Appointment not found." });
  // A cancel needs nothing, so a call with no Content-Type (and so no body) is allowed.
  const body = request.headers.has("content-type") ? await parseJsonBody(request, cancelBody) : {};
  return oneResult(await cancelAppointment(context, id, body));
});
