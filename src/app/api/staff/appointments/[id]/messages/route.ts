import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { quickMessageInputSchema, sendQuickMessage } from "@/server/quick-messages";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const appointmentIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

/** Sends the customer a quick message about this visit: your turn, running late, or please call us. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const parsed = appointmentIdSchema.safeParse((await context.params).id);
    if (!parsed.success) throw new ApiError(404, "appointment_not_found", "Appointment not found.");
    const idempotencyKey = getIdempotencyKey(request);
    const input = await parseJsonBody(request, quickMessageInputSchema, { maxBytes: 1_000 });
    return dataResponse(await sendQuickMessage(staff, parsed.data, input, idempotencyKey));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.appointment.quick_message", requestId);
  }
}
