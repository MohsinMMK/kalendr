import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { importVersionInput } from "@/server/imports/contracts";
import { importIdOf, startCommit } from "@/server/imports/service";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Starts the import from a checked file. The worker commits it in batches; poll the job for progress. */
export async function POST(request: Request, route: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const id = importIdOf((await route.params).id);
    const { expectedVersion } = await parseJsonBody(request, importVersionInput);
    return dataResponse(await startCommit(context, id, expectedVersion), 202);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.imports.commit", requestId);
  }
}
