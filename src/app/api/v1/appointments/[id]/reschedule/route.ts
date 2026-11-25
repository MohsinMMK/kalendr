import { oneResult, v1Route } from "@/server/api-v1";
import { rescheduleBody } from "@/server/api-v1-contracts";
import { pathId } from "@/server/api-v1-reads";
import { rescheduleAppointment } from "@/server/api-v1-writes";
import { parseJsonBody } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = v1Route("v1.appointments.reschedule", "appointments:write", async ({ request, context, params }) => {
  const id = pathId(params.id, { code: "appointment_not_found", message: "Appointment not found." });
  const body = await parseJsonBody(request, rescheduleBody);
  return oneResult(await rescheduleAppointment(context, id, body));
});
