import { broadcastSchema } from "@/lib/classes-contracts";
import { messageEveryone } from "@/server/classes";
import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Messages everyone on the roster. Repeating the request with the same key sends nothing twice. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const idempotencyKey = getIdempotencyKey(request);
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await messageEveryone(context, (await params).id, await parseJsonBody(request, broadcastSchema), idempotencyKey));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.classes.message", requestId);
  }
}
