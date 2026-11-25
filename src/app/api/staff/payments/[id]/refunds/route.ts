import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { refundInputSchema, refundPayment } from "@/server/payments";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paymentIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

/** Gives money back against one payment. The payment itself is never changed. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const parsed = paymentIdSchema.safeParse((await context.params).id);
    if (!parsed.success) throw new ApiError(404, "payment_not_found", "That payment could not be found.");
    const idempotencyKey = getIdempotencyKey(request);
    const input = await parseJsonBody(request, refundInputSchema, { maxBytes: 1_000 });
    const result = await refundPayment(staff, parsed.data, input, idempotencyKey);
    // 202: money taken online goes back through the provider, so the refund is asked for, not yet paid out.
    return dataResponse(result, result.refundQueued ? 202 : 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.payments.refund", requestId);
  }
}
