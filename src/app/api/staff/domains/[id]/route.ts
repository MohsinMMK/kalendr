import { removeDomain } from "@/server/domains/service";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Disconnects an address. It stops being served at once. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await removeDomain(context, (await params).id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.domains.remove", requestId);
  }
}
