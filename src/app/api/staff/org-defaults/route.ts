import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { orgDefaultsSchema } from "@/lib/enterprise-contracts";
import { getOrgDefaults, saveOrgDefaults } from "@/server/enterprise/defaults";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await getOrgDefaults(context), 200);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.org_defaults.get", requestId);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await saveOrgDefaults(context, await parseJsonBody(request, orgDefaultsSchema)), 200);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.org_defaults.save", requestId);
  }
}
