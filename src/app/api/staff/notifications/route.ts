import { dataResponse, routeErrorResponse } from "@/server/http";
import { getStaffContext } from "@/server/staff-context";
import { listNotifications } from "@/server/staff-notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The caller's own recent alerts and how many are unread. Everyone on staff has them. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await listNotifications(context));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.notifications.list", requestId);
  }
}
