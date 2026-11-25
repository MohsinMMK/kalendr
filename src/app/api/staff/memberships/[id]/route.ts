import { z } from "zod";

import { membershipActionInputSchema } from "@/lib/offers-contracts";
import { ApiError } from "@/server/api-error";
import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { changeMembership, renewMembership } from "@/server/offers/memberships";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

/** Cancel, pause or resume a membership, or record this month's payment for one billed by hand. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) throw new ApiError(404, "membership_not_found", "That membership could not be found.");
    const input = await parseJsonBody(request, membershipActionInputSchema, { maxBytes: 500 });
    if (input.action === "renew") {
      if (!input.method) throw new ApiError(400, "validation_error", "Choose how the payment was taken.");
      return dataResponse(await renewMembership(staff, id.data, input.method, getIdempotencyKey(request)), 201);
    }
    return dataResponse(await changeMembership(staff, id.data, input.action));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.memberships.change", requestId);
  }
}
