import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { callNextInputSchema, callNextTicket } from "@/server/queue";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Calls the next waiting customer. Returns null when no one is waiting. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const input = await parseJsonBody(request, callNextInputSchema, { maxBytes: 2_000 });
    return dataResponse(await callNextTicket(context, input));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.queue.call_next", requestId);
  }
}
