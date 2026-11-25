import { reasonOnlyInputSchema } from "@/lib/admin-contracts";
import { getAdminContext, requireAdminCapability } from "@/server/admin-context";
import { queueVerificationResend } from "@/server/admin/actions";
import { businessIdFrom, type IdRouteContext } from "@/server/admin/http";
import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Queues the verification email for the business's owner. The worker sends it; this request never reads the address. */
export async function POST(request: Request, context: IdRouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const admin = await getAdminContext(request.headers);
    requireAdminCapability(admin, "operate");
    const tenantId = await businessIdFrom(context);
    // Screens send an Idempotency-Key; without one, repeats within the same minute count as one click.
    const key = request.headers.get("idempotency-key") ? getIdempotencyKey(request) : `auto:${tenantId}:${Math.floor(Date.now() / 60_000)}`;
    const input = await parseJsonBody(request, reasonOnlyInputSchema);
    return dataResponse(await queueVerificationResend(admin.userId, tenantId, input.reason, key));
  } catch (error: unknown) {
    return routeErrorResponse(error, "admin.tenants.resend_verification", requestId);
  }
}
