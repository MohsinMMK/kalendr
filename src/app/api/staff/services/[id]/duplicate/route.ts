import { dataResponse, routeErrorResponse } from "@/server/http";
import { duplicateService } from "@/server/services-admin";
import { getStaffContext, requirePermission } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    requirePermission(staff, "settings.manage");
    const { id } = await context.params;
    return dataResponse(await duplicateService(staff, id), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.service.duplicate", requestId);
  }
}
