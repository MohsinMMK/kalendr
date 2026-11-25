import { bulkInputSchema } from "@/lib/bookings-list";
import { runBulkAction } from "@/server/bulk-actions";
import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One action on up to 100 bookings. Each booking succeeds or fails on its own; the answer lists both. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const key = getIdempotencyKey(request);
    return dataResponse(await runBulkAction(context, await parseJsonBody(request, bulkInputSchema), key));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.bookings.bulk", requestId);
  }
}
