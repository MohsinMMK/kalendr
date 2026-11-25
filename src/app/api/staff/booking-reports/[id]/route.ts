import { z } from "zod";

import { decideReportInput } from "@/lib/spam-contact";
import { ApiError } from "@/server/api-error";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { decideBookingReport } from "@/server/spam";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

/** Ignore a report, or block the reported email, phone or domain. */
export async function PATCH(request: Request, route: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const id = idSchema.safeParse((await route.params).id);
    if (!id.success) throw new ApiError(404, "report_not_found", "That report no longer exists.");
    return dataResponse(await decideBookingReport(context, id.data, await parseJsonBody(request, decideReportInput)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.booking-report.decide", requestId);
  }
}
