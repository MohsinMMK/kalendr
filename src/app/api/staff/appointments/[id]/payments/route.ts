import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { getVisitPayments, recordPayment, recordPaymentInputSchema } from "@/server/payments";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const appointmentIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

async function appointmentId(params: Promise<{ id: string }>): Promise<string> {
  const parsed = appointmentIdSchema.safeParse((await params).id);
  if (!parsed.success) throw new ApiError(404, "appointment_not_found", "That visit could not be found.");
  return parsed.data;
}

/** What this visit costs, what has been paid and given back, and what is still due. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    return dataResponse(await getVisitPayments(staff, await appointmentId(context.params)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.payments.list", requestId);
  }
}

/** Records money taken at the desk for this visit. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const id = await appointmentId(context.params);
    const idempotencyKey = getIdempotencyKey(request);
    const input = await parseJsonBody(request, recordPaymentInputSchema, { maxBytes: 1_000 });
    return dataResponse(await recordPayment(staff, id, input, idempotencyKey), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.payments.collect", requestId);
  }
}
