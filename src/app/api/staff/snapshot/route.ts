import { getStaffContext } from "@/server/staff-context";
import { getStaffSnapshot } from "@/server/staff-repository";
import { dataResponse, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await getStaffSnapshot(context));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.snapshot", requestId);
  }
}
