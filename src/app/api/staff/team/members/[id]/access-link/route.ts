import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { sendMemberAccessLink } from "@/server/staff-team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Resends an invite, or sends a password reset link once they have a password. */
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
    return dataResponse(await sendMemberAccessLink(staff, id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.team.member.access_link", requestId);
  }
}
