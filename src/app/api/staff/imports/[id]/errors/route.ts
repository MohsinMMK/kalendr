import { routeErrorResponse } from "@/server/http";
import { importIdOf, importErrorFile } from "@/server/imports/service";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The rows that failed, with their original columns and a reason, ready to fix and upload again. */
export async function GET(request: Request, route: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const file = await importErrorFile(await getStaffContext(request.headers), importIdOf((await route.params).id));
    return new Response(file.csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.imports.errors", requestId);
  }
}
