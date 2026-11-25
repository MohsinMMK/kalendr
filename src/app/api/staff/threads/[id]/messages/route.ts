import { z } from "zod";

import { replyInput } from "@/lib/inbox-contracts";
import { ApiError } from "@/server/api-error";
import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { sendThreadReply } from "@/server/threads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);

/** Queues a reply to the customer. The worker sends it; nothing here calls WhatsApp. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) throw new ApiError(404, "thread_not_found", "That conversation was not found.");
    const input = await parseJsonBody(request, replyInput);
    return dataResponse(await sendThreadReply(staff, id.data, input, getIdempotencyKey(request)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.threads.reply", requestId);
  }
}
