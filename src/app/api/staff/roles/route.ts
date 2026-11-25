import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { customRoleInputSchema } from "@/lib/enterprise-contracts";
import { createCustomRole, listCustomRoles } from "@/server/enterprise/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await listCustomRoles(context), 200);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.roles.list", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await createCustomRole(context, await parseJsonBody(request, customRoleInputSchema)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.roles.create", requestId);
  }
}
