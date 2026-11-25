import { requestDomainCheck } from "@/server/domains/service";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Check now". Queues one lookup for the worker and answers at once; the screen then polls the list for the result. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await requestDomainCheck(context, (await params).id), 202);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.domains.verify", requestId);
  }
}
