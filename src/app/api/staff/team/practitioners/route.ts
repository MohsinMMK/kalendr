import { staffCreatePractitionerSchema } from "@/server/contracts";
import { parseJsonBody, dataResponse, routeErrorResponse } from "@/server/http";
import { getStaffContext, requirePermission } from "@/server/staff-context";
import { createStaffPractitioner } from "@/server/staff-team";
import { applyFeatureLimits, loadStaffBusinessProfile } from "@/server/business-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    requirePermission(context, "team.manage");
    const input = applyFeatureLimits(await parseJsonBody(request, staffCreatePractitionerSchema, { maxBytes: 160 * 1_024 }), await loadStaffBusinessProfile(context));
    return dataResponse(await createStaffPractitioner(context, input), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.team.practitioner.create", requestId);
  }
}
