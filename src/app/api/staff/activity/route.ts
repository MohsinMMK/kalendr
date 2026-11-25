import { auditQuerySchema } from "@/lib/enterprise-contracts";
import { dataResponse, parseQuery, routeErrorResponse } from "@/server/http";
import { listActivity } from "@/server/staff-activity";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The activity log, newest first. Filters: who, what kind of event, outcome and a range of days. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    const query = parseQuery(request, auditQuerySchema);
    return dataResponse(await listActivity(staff, { category: query.category, cursor: query.cursor ?? null, actor: query.actor, action: query.action, outcome: query.outcome, from: query.from, to: query.to }));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.activity.list", requestId);
  }
}
