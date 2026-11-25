import { conflictActionSchema } from "@/lib/calendar-sync";
import { resolveConflict } from "@/server/calendar-conflicts";
import { getCalendarOverview } from "@/server/calendar-sync";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Settles one "needs a person" item: move the appointment to match, put the calendar event back, or dismiss. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { id } = await params;
    const input = await parseJsonBody(request, conflictActionSchema, { maxBytes: 300 });
    await resolveConflict(context, id, input.action);
    return dataResponse(await getCalendarOverview(context));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.calendars.conflict", requestId);
  }
}
