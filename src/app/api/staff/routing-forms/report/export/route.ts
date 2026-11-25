import { z } from "zod";

import { reportRangeSchema } from "@/lib/routing-forms";
import { parseQuery, routeErrorResponse } from "@/server/http";
import { routingCsv } from "@/server/routing-forms/report";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = reportRangeSchema.extend({ formId: z.string().trim().min(1).max(80).optional() }).strict();

/** One row per response, with the route and funnel steps. It never contains what customers typed. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    const query = parseQuery(request, querySchema);
    const csv = await routingCsv(context, query.formId ?? null, query);
    return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="routing-responses.csv"', "Cache-Control": "no-store" } });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.routing_forms.export", requestId);
  }
}
