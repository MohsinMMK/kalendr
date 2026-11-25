import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { routeErrorResponse } from "@/server/http";
import { downloadExport } from "@/server/reports/service";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Downloads a finished export. Only the person who asked can, and only for a day. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    const id = z.string().min(1).max(80).safeParse((await context.params).id);
    if (!id.success) throw new ApiError(404, "export_not_found", "That export is not available.");
    const file = await downloadExport(staff, id.data);
    return new Response(file.body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Request-Id": requestId,
      },
    });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.reports.download", requestId);
  }
}
