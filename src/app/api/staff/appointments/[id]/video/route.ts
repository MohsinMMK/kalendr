import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { getStaffVideo, staffAdmit, staffHeartbeat, staffHost } from "@/server/video/visit-service";
import { staffVideoActionSchema } from "@/lib/video-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Context { params: Promise<{ id: string }> }

export async function GET(request: Request, context: Context): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await getStaffVideo(await getStaffContext(request.headers), (await context.params).id));
  } catch (error) {
    return routeErrorResponse(error, "staff.video.read", requestId);
  }
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const { id } = await context.params;
    const input = await parseJsonBody(request, staffVideoActionSchema);
    if (input.action === "host") return dataResponse(await staffHost(staff, id));
    if (input.action === "admit") return dataResponse(await staffAdmit(staff, id));
    return dataResponse(await staffHeartbeat(staff, id));
  } catch (error) {
    return routeErrorResponse(error, "staff.video.act", requestId);
  }
}
