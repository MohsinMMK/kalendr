import { oneResult, v1Route } from "@/server/api-v1";
import { getAppointment, pathId } from "@/server/api-v1-reads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = v1Route("v1.appointments.get", "appointments:read", async ({ context, params }) => {
  const id = pathId(params.id, { code: "appointment_not_found", message: "Appointment not found." });
  return oneResult(await getAppointment(context.tenantId, id));
});
