import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { offerByHand, offerByHandInput } from "@/server/waitlist-staff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Offers a time to one waiting person by hand. Needs an Idempotency-Key, so a double click makes one offer. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success) throw new ApiError(404, "waitlist_not_found", "Waitlist entry not found.");
    const key = getIdempotencyKey(request);
    return dataResponse(await offerByHand(context, id, await parseJsonBody(request, offerByHandInput), key), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.waitlist.offer", requestId);
  }
}
