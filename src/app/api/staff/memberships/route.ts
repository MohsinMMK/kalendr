import { enrolMembershipInputSchema } from "@/lib/offers-contracts";
import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { enrolMembership } from "@/server/offers/memberships";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Starts a membership at the desk, billed by hand each month. The first month is paid now. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const idempotencyKey = getIdempotencyKey(request);
    return dataResponse(await enrolMembership(staff, await parseJsonBody(request, enrolMembershipInputSchema, { maxBytes: 1_000 }), idempotencyKey), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.memberships.enrol", requestId);
  }
}
