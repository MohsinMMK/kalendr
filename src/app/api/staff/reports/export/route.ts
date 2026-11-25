import { exportRequestSchema } from "@/lib/reports";
import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { listExports, requestExport } from "@/server/reports/service";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Exports a report as CSV. A short range comes back as the file; a long one is queued for the worker (202) and the screen
 * lists it under Ready exports. Needs reports.export and an Idempotency-Key, and is written to the activity log.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const key = getIdempotencyKey(request);
    const body = await parseJsonBody(request, exportRequestSchema);
    const outcome = await requestExport(staff, body, key);
    if (outcome.kind === "queued") return dataResponse(outcome, 202);
    return new Response(outcome.body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${outcome.filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Request-Id": requestId,
      },
    });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.reports.export", requestId);
  }
}

/** The person's own recent exports and whether the worker has finished them. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await listExports(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.reports.exports", requestId);
  }
}
