import { listResult, oneResult, pageQuerySchema, v1Route } from "@/server/api-v1";
import { appointmentListQuery, createAppointmentBody } from "@/server/api-v1-contracts";
import { listAppointments } from "@/server/api-v1-reads";
import { bookAppointment } from "@/server/api-v1-writes";
import { getIdempotencyKey, parseJsonBody, parseQuery } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = v1Route("v1.appointments.list", "appointments:read", async ({ request, context }) => {
  const { limit, cursor } = parseQuery(request, pageQuerySchema);
  const filters = parseQuery(request, appointmentListQuery);
  const page = await listAppointments(context.tenantId, filters, limit, cursor);
  return listResult(page.items, page.nextCursor);
});

export const POST = v1Route("v1.appointments.create", "appointments:write", async ({ request, context }) => {
  const idempotencyKey = getIdempotencyKey(request);
  const body = await parseJsonBody(request, createAppointmentBody);
  return oneResult(await bookAppointment(context, body, idempotencyKey), 201);
});
