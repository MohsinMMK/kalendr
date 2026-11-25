import { staffLinkProfileSchema } from "@/server/contracts";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { linkMemberToProfile, unlinkMemberFromProfile } from "@/server/staff-team-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Links this login to a bookable profile that has none. */
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
    const input = await parseJsonBody(request, staffLinkProfileSchema);
    return dataResponse(await linkMemberToProfile(staff, id, input.practitionerId));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.team.member.profile_link", requestId);
  }
}

/** Separates this login from its profile; the profile and its history stay. */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    assertNotImpersonating(staff);
    const { id } = await context.params;
    return dataResponse(await unlinkMemberFromProfile(staff, id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.team.member.profile_unlink", requestId);
  }
}
