import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { withdrawOffer } from "@/server/waitlist-staff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lets a held time go: the live offer is withdrawn and the time returns to public booking. Repeating it changes nothing. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success) throw new ApiError(404, "offer_not_found", "That offer was not found.");
    return dataResponse(await withdrawOffer(context, id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.waitlist.offer.withdraw", requestId);
  }
}
