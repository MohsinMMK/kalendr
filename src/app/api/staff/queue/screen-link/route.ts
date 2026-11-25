import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { createScreenLink, screenLinkInputSchema } from "@/server/queue-screens";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Makes a new waiting-room screen link. The old link stops working. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const input = await parseJsonBody(request, screenLinkInputSchema, { maxBytes: 1_000 });
    return dataResponse(await createScreenLink(staff, input), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.queue.screen_link", requestId);
  }
}
