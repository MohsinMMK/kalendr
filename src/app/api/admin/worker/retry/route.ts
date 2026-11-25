import { retryInputSchema } from "@/lib/admin-contracts";
import { getAdminContext, requireAdminCapability } from "@/server/admin-context";
import { retryDeadLetter } from "@/server/admin/worker";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Puts one dead letter back in the queue. A second click finds it no longer dead and says so instead of acting twice. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const admin = await getAdminContext(request.headers);
    requireAdminCapability(admin, "operate");
    const input = await parseJsonBody(request, retryInputSchema);
    return dataResponse({ retried: await retryDeadLetter(admin.userId, input.eventId, input.reason) });
  } catch (error: unknown) {
    return routeErrorResponse(error, "admin.worker.retry", requestId);
  }
}
