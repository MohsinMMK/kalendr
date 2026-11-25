import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { queueTicketActionSchema, updateQueueTicket } from "@/server/queue";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ticketIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

/** Call again, skip, or mark a token urgent. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const parsed = ticketIdSchema.safeParse((await context.params).id);
    if (!parsed.success) throw new ApiError(404, "ticket_not_found", "That token is no longer in today's queue.");
    const input = await parseJsonBody(request, queueTicketActionSchema, { maxBytes: 2_000 });
    return dataResponse(await updateQueueTicket(staff, parsed.data, input));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.queue.ticket", requestId);
  }
}
