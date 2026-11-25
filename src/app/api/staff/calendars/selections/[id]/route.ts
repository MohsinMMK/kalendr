import { selectionPatchSchema } from "@/lib/calendar-sync";
import { updateSelection } from "@/server/calendar-sync";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tick "blocks my availability" or choose where new bookings are written. Checks the version the screen last saw. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { id } = await params;
    const patch = await parseJsonBody(request, selectionPatchSchema, { maxBytes: 1_000 });
    return dataResponse(await updateSelection(context, id, patch));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.calendars.selection", requestId);
  }
}
