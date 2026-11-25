import { dataResponse, parseQuery, routeErrorResponse } from "@/server/http";
import { listStaffRequests, requestFilterSchema } from "@/server/privacy/requests";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Customer privacy requests with days remaining, oldest due date first. Query: status=open|closed|all, type, overdue=true|false. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    const filter = parseQuery(request, requestFilterSchema);
    return dataResponse(await listStaffRequests(context, filter));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.privacy.requests.list", requestId);
  }
}
