import { explainQuerySchema } from "@/lib/availability-setup";
import { ApiError } from "@/server/api-error";
import { explainSlots } from "@/server/availability-extras";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Why no slot?": for each 15 minutes of one day, the first rule that removed it. Read only. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    const parsed = explainQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()));
    if (!parsed.success) throw new ApiError(400, "validation_error", "Choose a person, a service, a place and a day.");
    return dataResponse(await explainSlots(context, parsed.data));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.availability.explain", requestId);
  }
}
