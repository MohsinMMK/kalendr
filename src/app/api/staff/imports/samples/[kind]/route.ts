import { ApiError } from "@/server/api-error";
import { routeErrorResponse } from "@/server/http";
import { isImportKind } from "@/server/imports/contracts";
import { sampleFor } from "@/server/imports/samples";
import { getStaffContext, requirePermission } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A small example file for one kind, with made-up people. */
export async function GET(request: Request, route: { params: Promise<{ kind: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    requirePermission(await getStaffContext(request.headers), "settings.manage");
    const { kind } = await route.params;
    if (!isImportKind(kind)) throw new ApiError(404, "import_not_found", "There is no sample for that.");
    return new Response(sampleFor(kind), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="sample-${kind}.csv"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.imports.sample", requestId);
  }
}
