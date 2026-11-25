import { ApiError } from "@/server/api-error";
import { staffSearchQuerySchema } from "@/lib/search";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { searchStaff } from "@/server/search/staff-search";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The command palette's search. Read-only, so it needs no write guard; every kind inside is gated by the person's permissions. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    const parsed = staffSearchQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()));
    if (!parsed.success) throw new ApiError(400, "validation_error", "Type at least two characters to search.");
    return dataResponse(await searchStaff(context, parsed.data.q, parsed.data.limit));
  } catch (error: unknown) {
    // The route name goes to the log with the request id; the search text never does.
    return routeErrorResponse(error, "staff.search", requestId);
  }
}
