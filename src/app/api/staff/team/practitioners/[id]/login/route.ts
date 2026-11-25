import { staffPractitionerLoginSchema } from "@/server/contracts";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { invitePractitionerLogin } from "@/server/staff-team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Gives a practitioner who was added without a login their own sign-in, and sends the invite link. */
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
    const { email } = await parseJsonBody(request, staffPractitionerLoginSchema);
    return dataResponse(await invitePractitionerLogin(staff, id, email), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.team.practitioner.login", requestId);
  }
}
