import { auditQuerySchema } from "@/lib/enterprise-contracts";
import { exportActivityCsv } from "@/server/activity-export";
import { parseQuery, routeErrorResponse } from "@/server/http";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The same filters as the viewer, as a spreadsheet file. Needs a recent second-factor check. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    const query = parseQuery(request, auditQuerySchema);
    const csv = await exportActivityCsv(staff, { category: query.category, actor: query.actor, action: query.action, outcome: query.outcome, from: query.from, to: query.to });
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="activity-log.csv"', "cache-control": "no-store" } });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.activity.export", requestId);
  }
}
