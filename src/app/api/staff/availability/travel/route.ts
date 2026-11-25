import { travelPeriodCreateSchema } from "@/lib/availability-setup";
import { ApiError } from "@/server/api-error";
import { createTravel, listTravel } from "@/server/availability-extras";
import { optionalIdempotencyKey, requiredQuery } from "@/server/availability-http";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    const practitionerId = requiredQuery(request, "practitionerId");
    if (!practitionerId) throw new ApiError(400, "validation_error", "Choose a person.", { practitionerId: ["Choose a person."] });
    return dataResponse(await listTravel(context, practitionerId));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.availability.travel.list", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const input = await parseJsonBody(request, travelPeriodCreateSchema);
    return dataResponse(await createTravel(context, input, optionalIdempotencyKey(request)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.availability.travel.create", requestId);
  }
}
