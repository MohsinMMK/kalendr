import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { delayNoticeInputSchema, sendDelayNotice } from "@/server/quick-messages";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tells everyone still to be seen today that the business is running late. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const idempotencyKey = getIdempotencyKey(request);
    const input = await parseJsonBody(request, delayNoticeInputSchema, { maxBytes: 1_000 });
    return dataResponse(await sendDelayNotice(staff, input, idempotencyKey));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.messages.delay", requestId);
  }
}
