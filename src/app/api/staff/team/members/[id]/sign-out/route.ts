import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { signOutStaffMember } from "@/server/staff-team-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Signs a person out of every device. */
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
    return dataResponse(await signOutStaffMember(staff, id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.team.member.sign_out", requestId);
  }
}
