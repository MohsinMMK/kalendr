import { timeOffCreateSchema } from "@/lib/availability-setup";
import { createTimeOff, listTimeOff } from "@/server/availability-extras";
import { optionalIdempotencyKey, requiredQuery } from "@/server/availability-http";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Out of office that has not ended yet. Add `practitionerId` for one person. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await listTimeOff(context, requiredQuery(request, "practitionerId") || null));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.availability.time-off.list", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const input = await parseJsonBody(request, timeOffCreateSchema);
    return dataResponse(await createTimeOff(context, input, optionalIdempotencyKey(request)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.availability.time-off.create", requestId);
  }
}
