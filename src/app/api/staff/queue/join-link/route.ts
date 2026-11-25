import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { joinLinkInputSchema, setupJoinLink } from "@/server/queue-door";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Makes or replaces the door QR code's link, or turns door sign-ups on or off. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const input = await parseJsonBody(request, joinLinkInputSchema, { maxBytes: 1_000 });
    return dataResponse(await setupJoinLink(staff, input), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.queue.join_link", requestId);
  }
}
