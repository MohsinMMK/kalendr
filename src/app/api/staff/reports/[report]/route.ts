import { z } from "zod";

import { reportKeys, reportParamsSchema } from "@/lib/reports";
import { ApiError } from "@/server/api-error";
import { dataResponse, parseQuery, routeErrorResponse } from "@/server/http";
import { runReport } from "@/server/reports/service";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const reportSchema = z.enum(reportKeys);

/** One report for a date range, a place and a person. A practitioner always gets their own numbers; revenue needs reports.revenue. */
export async function GET(request: Request, context: { params: Promise<{ report: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    const report = reportSchema.safeParse((await context.params).report);
    if (!report.success) throw new ApiError(404, "report_not_found", "That report does not exist.");
    const params = parseQuery(request, reportParamsSchema);
    return dataResponse(await runReport(staff, report.data, params));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.reports.read", requestId);
  }
}
