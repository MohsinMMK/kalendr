import { ApiError } from "@/server/api-error";
import { closeDay, closeDayInputSchema, dayEndQuerySchema, getDayEnd } from "@/server/day-end";
import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The day-end summary for a location: who was seen, money by method, what is still owed. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    const params = new URL(request.url).searchParams;
    const query = dayEndQuerySchema.safeParse({
      day: params.get("day") ?? undefined,
      locationId: params.get("locationId") ?? undefined,
    });
    if (!query.success) throw new ApiError(400, "invalid_query", "Pick a day like 2026-11-19.");
    return dataResponse(await getDayEnd(staff, query.data));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.day_end.get", requestId);
  }
}

/** Closes the day with the cash count. Saved once; a closed day cannot change. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const idempotencyKey = getIdempotencyKey(request);
    const input = await parseJsonBody(request, closeDayInputSchema, { maxBytes: 2_000 });
    return dataResponse(await closeDay(staff, input, idempotencyKey), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.day_end.close", requestId);
  }
}
