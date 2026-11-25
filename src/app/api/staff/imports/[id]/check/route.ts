import { dataResponse, routeErrorResponse } from "@/server/http";
import { importIdOf, startCheck } from "@/server/imports/service";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Queues the dry run. The worker looks at every row and writes nothing to customers, services or appointments. */
export async function POST(request: Request, route: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    return dataResponse(await startCheck(staff, importIdOf((await route.params).id)), 202);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.imports.check", requestId);
  }
}
