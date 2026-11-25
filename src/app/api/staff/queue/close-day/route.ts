import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { closeDayInputSchema, closeQueueDay } from "@/server/queue-door";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Closes today's queue: nobody new can join from the door, and those still waiting are let go. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const input = await parseJsonBody(request, closeDayInputSchema, { maxBytes: 1_000 });
    return dataResponse(await closeQueueDay(staff, input));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.queue.close_day", requestId);
  }
}
