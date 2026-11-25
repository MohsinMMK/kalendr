import { staffMemberEmailChangeSchema } from "@/lib/staff-email";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext, requirePermission } from "@/server/staff-context";
import { changeMemberEmail } from "@/server/staff-email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** An owner or admin changes a teammate's sign-in email. Needs a fresh second-factor check; see `changeMemberEmail`. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    assertNotImpersonating(staff);
    requirePermission(staff, "team.manage");
    const { id } = await context.params;
    const input = await parseJsonBody(request, staffMemberEmailChangeSchema);
    return dataResponse(await changeMemberEmail(staff, id, input));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.team.member.email", requestId);
  }
}
