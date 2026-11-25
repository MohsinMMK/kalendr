import { dataResponse, routeErrorResponse } from "@/server/http";
import { listUndeliveredMessages, undeliveredFilters, type UndeliveredFilter } from "@/server/message-retry";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Messages the worker could not send: `?status=failed` (still retrying), `dead_letter` (gave up) or `all`. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    const requested = new URL(request.url).searchParams.get("status") ?? "all";
    const filter: UndeliveredFilter = (undeliveredFilters as readonly string[]).includes(requested) ? requested as UndeliveredFilter : "all";
    return dataResponse(await listUndeliveredMessages(staff, filter));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.messages.undelivered", requestId);
  }
}
