import { regenerateDomainToken } from "@/server/domains/service";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Shows the records again by making a new TXT value. The old value stops working and the 72 hours start over. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await regenerateDomainToken(context, (await params).id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.domains.token", requestId);
  }
}
