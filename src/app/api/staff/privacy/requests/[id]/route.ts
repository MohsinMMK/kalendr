import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { decideRequest, decisionInputSchema } from "@/server/privacy/requests";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestIdSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);

/**
 * Approves or refuses a request. Needs an Idempotency-Key header and the request's current `version`. Approving an
 * erasure also needs a second-factor check from the last 10 minutes (403 step_up_required).
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    assertNotImpersonating(staff);
    const parsed = requestIdSchema.safeParse((await context.params).id);
    if (!parsed.success) throw new ApiError(404, "not_found", "That request was not found.");
    const key = getIdempotencyKey(request);
    const input = await parseJsonBody(request, decisionInputSchema);
    return dataResponse(await decideRequest(staff, parsed.data, input, key));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.privacy.requests.decide", requestId);
  }
}
