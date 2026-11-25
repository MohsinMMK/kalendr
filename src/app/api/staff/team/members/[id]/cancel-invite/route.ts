import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { cancelStaffInvite } from "@/server/staff-team-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cancels an invite that was never used: the person and their link are removed. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    assertNotImpersonating(staff);
    const { id } = await context.params;
    return dataResponse(await cancelStaffInvite(staff, id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.team.member.cancel_invite", requestId);
  }
}
