import { bookingQueryFromParams } from "@/lib/bookings-list";
import { seriesListQuerySchema } from "@/lib/series-list";
import { ApiError } from "@/server/api-error";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { listSeries } from "@/server/series-list";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Repeating tab of the bookings list: repeating series with their next visit, filters and a cursor, all from the query string. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    const parsed = seriesListQuerySchema.safeParse(bookingQueryFromParams(new URL(request.url).searchParams));
    if (!parsed.success) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of parsed.error.issues) (fieldErrors[String(issue.path[0] ?? "query")] ??= []).push(issue.message);
      throw new ApiError(400, "validation_error", "Check the filters and try again.", fieldErrors);
    }
    return dataResponse(await listSeries(context, parsed.data));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.bookings.series", requestId);
  }
}
