import { dataResponse, routeErrorResponse } from "@/server/http";
import { importIdOf, startUndo } from "@/server/imports/service";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reverses an import for seven days after it finished: removes only what it made and nobody has used since. */
export async function POST(request: Request, route: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    return dataResponse(await startUndo(staff, importIdOf((await route.params).id)), 202);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.imports.undo", requestId);
  }
}
