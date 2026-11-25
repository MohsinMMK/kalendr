import { scheduleCreateSchema } from "@/lib/availability-setup";
import { createSchedule, listSchedules } from "@/server/availability-admin";
import { optionalIdempotencyKey, requiredQuery } from "@/server/availability-http";
import { ApiError } from "@/server/api-error";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One person's schedules, each with its weekly hours and date overrides. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    const practitionerId = requiredQuery(request, "practitionerId");
    if (!practitionerId) throw new ApiError(400, "validation_error", "Choose a person.", { practitionerId: ["Choose a person."] });
    return dataResponse(await listSchedules(context, practitionerId));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.availability.schedules.list", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const input = await parseJsonBody(request, scheduleCreateSchema);
    return dataResponse(await createSchedule(context, input, optionalIdempotencyKey(request)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.availability.schedules.create", requestId);
  }
}
