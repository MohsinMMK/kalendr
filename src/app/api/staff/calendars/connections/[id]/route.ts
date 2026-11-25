import { z } from "zod";

import { disconnectCalendar } from "@/server/calendar-sync";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stops reading a calendar account and forgets what was saved from it. The calendar itself is untouched. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    assertNotImpersonating(context);
    const { id } = await params;
    await parseJsonBody(request, z.object({}), { maxBytes: 200 });
    return dataResponse(await disconnectCalendar(context, id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.calendars.disconnect", requestId);
  }
}
