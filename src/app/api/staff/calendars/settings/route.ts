import { calendarSettingsInputSchema } from "@/lib/calendar-sync";
import { setEventText } from "@/server/calendar-sync";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How much of an appointment is written into calendars and the private feed (owner and admins). */
export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    assertNotImpersonating(context);
    const input = await parseJsonBody(request, calendarSettingsInputSchema, { maxBytes: 500 });
    return dataResponse(await setEventText(context, input.eventText));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.calendars.settings", requestId);
  }
}
