import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { createTicketLink } from "@/server/queue-screens";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

/** Makes the customer's own link to their place in the queue, for a QR or a text. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) throw new ApiError(404, "ticket_not_found", "That token is no longer in today's queue.");
    return dataResponse(await createTicketLink(staff, id.data), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.queue.phone_link", requestId);
  }
}
