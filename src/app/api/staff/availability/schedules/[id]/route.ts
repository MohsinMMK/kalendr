import { scheduleUpdateSchema } from "@/lib/availability-setup";
import { deleteSchedule, updateSchedule } from "@/server/availability-admin";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { rescheduleAffectedAppointments } from "@/server/timing-automation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Saves with `expectedVersion`. When the main hours change, visits that no longer fit are moved as before. */
export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { id } = await params;
    const input = await parseJsonBody(request, scheduleUpdateSchema);
    const change = await updateSchedule(context, id, input);
    const timing = change.hoursChanged
      ? await rescheduleAffectedAppointments(context, change.schedule.practitionerId)
      : { moved: [], unresolved: [] };
    return dataResponse({ schedule: change.schedule, timing });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.availability.schedules.update", requestId);
  }
}

export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { id } = await params;
    return dataResponse(await deleteSchedule(context, id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.availability.schedules.delete", requestId);
  }
}
