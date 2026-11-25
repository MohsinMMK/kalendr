import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { getMyNotificationSettings, notificationSettingsInputSchema, saveMyNotificationSettings } from "@/server/staff-notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The caller's own alert choices, quiet hours and morning digest. Everyone on staff has them. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await getMyNotificationSettings(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.me.notifications.read", requestId);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await saveMyNotificationSettings(context, await parseJsonBody(request, notificationSettingsInputSchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.me.notifications.update", requestId);
  }
}
