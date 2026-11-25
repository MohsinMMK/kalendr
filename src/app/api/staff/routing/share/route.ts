import { z } from "zod";

import { monthSchema } from "@/lib/routing-contracts";
import { dataResponse, parseQuery, routeErrorResponse } from "@/server/http";
import { getTeamShare } from "@/server/routing-admin";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Each person's bookings for a month against the share their weights give them. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    const { month } = parseQuery(request, z.object({ month: monthSchema }));
    return dataResponse(await getTeamShare(context, month));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.routing.share", requestId);
  }
}
