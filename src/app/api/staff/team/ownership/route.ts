import { staffTransferOwnershipSchema } from "@/server/contracts";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { transferOwnership } from "@/server/staff-team-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The owner hands the business to another active person and becomes an admin. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    assertNotImpersonating(staff);
    const input = await parseJsonBody(request, staffTransferOwnershipSchema);
    return dataResponse(await transferOwnership(staff, input.membershipId));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.team.ownership.transfer", requestId);
  }
}
