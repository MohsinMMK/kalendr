import { ApiError } from "@/server/api-error";
import { timetableQuerySchema } from "@/lib/classes-contracts";
import { listTimetable } from "@/server/classes";
import { dataResponse, enforceLimit, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The public timetable: date, time, teacher and seats left. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "availability.ip");
    const parsed = timetableQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()));
    if (!parsed.success) throw new ApiError(400, "validation_error", "The timetable request is invalid.");
    return dataResponse({ sessions: await listTimetable(parsed.data) });
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.classes.list", requestId);
  }
}
