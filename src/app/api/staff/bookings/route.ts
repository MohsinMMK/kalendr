import { bookingQuerySchema, bookingQueryFromParams } from "@/lib/bookings-list";
import { ApiError } from "@/server/api-error";
import { listBookings } from "@/server/bookings-list";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The bookings list: tab, filters and a cursor, all from the query string so a link reproduces the view. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    const parsed = bookingQuerySchema.safeParse(bookingQueryFromParams(new URL(request.url).searchParams));
    if (!parsed.success) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of parsed.error.issues) (fieldErrors[String(issue.path[0] ?? "query")] ??= []).push(issue.message);
      throw new ApiError(400, "validation_error", "Check the filters and try again.", fieldErrors);
    }
    return dataResponse(await listBookings(context, parsed.data));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.bookings.list", requestId);
  }
}
