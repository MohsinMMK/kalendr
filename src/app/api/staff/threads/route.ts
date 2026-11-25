import { inboxFilters, type InboxFilter } from "@/lib/inbox-contracts";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { getStaffContext } from "@/server/staff-context";
import { listThreads } from "@/server/threads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Inbox list: `?filter=all|unread|mine`. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    const asked = new URL(request.url).searchParams.get("filter") ?? "all";
    const filter: InboxFilter = (inboxFilters as readonly string[]).includes(asked) ? asked as InboxFilter : "all";
    return dataResponse(await listThreads(staff, filter));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.threads.list", requestId);
  }
}
