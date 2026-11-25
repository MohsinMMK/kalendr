import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { retryInput, retryUndeliveredMessage } from "@/server/message-retry";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RetryRouteContext {
  params: Promise<{ id: string }>;
}

const idSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);

/** "Try again": puts a failed or dead-lettered message back in the worker's queue. */
export async function POST(request: Request, context: RetryRouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const parsed = idSchema.safeParse((await context.params).id);
    if (!parsed.success) throw new ApiError(404, "message_not_found", "Message not found.");
    const idempotencyKey = getIdempotencyKey(request);
    const input = await parseJsonBody(request, retryInput);
    return dataResponse(await retryUndeliveredMessage(staff, parsed.data, input, idempotencyKey));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.messages.retry", requestId);
  }
}
