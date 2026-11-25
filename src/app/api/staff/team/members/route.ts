import { staffCreateMemberSchema } from "@/server/contracts";
import { parseJsonBody, dataResponse, routeErrorResponse } from "@/server/http";
import { getStaffContext, requirePermission } from "@/server/staff-context";
import { createStaffMember } from "@/server/staff-team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    requirePermission(context, "team.manage");
    const input = await parseJsonBody(request, staffCreateMemberSchema);
    return dataResponse(await createStaffMember(context, input), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.team.member.create", requestId);
  }
}
