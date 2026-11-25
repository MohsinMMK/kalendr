import { dataResponse, parseQuery, routeErrorResponse } from "@/server/http";
import { importRowsQuery } from "@/server/imports/contracts";
import { importIdOf, listImportRows } from "@/server/imports/service";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Row outcomes: a status, a fixed error code and the field at fault. Never the values themselves. */
export async function GET(request: Request, route: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await listImportRows(context, importIdOf((await route.params).id), parseQuery(request, importRowsQuery)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.imports.rows", requestId);
  }
}
