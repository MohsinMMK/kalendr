import { z } from "zod";

import { reportRangeSchema } from "@/lib/routing-forms";
import { dataResponse, parseQuery, routeErrorResponse } from "@/server/http";
import { routingReport } from "@/server/routing-forms/report";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const reportQuerySchema = reportRangeSchema.extend({ formId: z.string().trim().min(1).max(80).optional() }).strict();

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    const query = parseQuery(request, reportQuerySchema);
    return dataResponse(await routingReport(context, query.formId ?? null, query));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.routing_forms.report", requestId);
  }
}
