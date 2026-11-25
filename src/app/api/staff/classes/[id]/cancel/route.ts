import { cancelSessionSchema } from "@/lib/classes-contracts";
import { cancelSession } from "@/server/classes";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cancels the session and tells everyone with a seat or waiting. Cancelling twice changes nothing more. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await cancelSession(context, (await params).id, await parseJsonBody(request, cancelSessionSchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.classes.cancel", requestId);
  }
}
