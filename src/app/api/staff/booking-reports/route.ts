import { z } from "zod";

import { dataResponse, routeErrorResponse } from "@/server/http";
import { listBookingReports } from "@/server/spam";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const statusSchema = z.enum(["open", "decided"]).default("open");

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    const status = statusSchema.parse(new URL(request.url).searchParams.get("status") ?? undefined);
    return dataResponse({ reports: await listBookingReports(context, status) });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.booking-reports.list", requestId);
  }
}
