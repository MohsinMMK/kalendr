import { securityPolicyInput } from "@/lib/security-policy";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { setSecurityPolicy } from "@/server/staff-security-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Owner or admin: ask every teammate for a second factor, or only owners and admins. Needs a code from the last 10 minutes. */
export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    assertNotImpersonating(context);
    return dataResponse(await setSecurityPolicy(context, await parseJsonBody(request, securityPolicyInput)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.security.policy", requestId);
  }
}
