import { rolloutInputSchema } from "@/lib/admin-contracts";
import { getAdminContext, requireAdminCapability, requireAdminStepUp } from "@/server/admin-context";
import { listRollouts, setRollout } from "@/server/admin/rollouts";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const admin = await getAdminContext(request.headers);
    requireAdminCapability(admin, "readOverview");
    return dataResponse(await listRollouts());
  } catch (error: unknown) {
    return routeErrorResponse(error, "admin.rollouts.list", requestId);
  }
}

/** Sets one feature's rollout. Setting the same thing twice changes nothing, so no Idempotency-Key is needed. */
export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const admin = await getAdminContext(request.headers);
    requireAdminCapability(admin, "manageRollouts");
    requireAdminStepUp(admin);
    await setRollout(admin.userId, await parseJsonBody(request, rolloutInputSchema, { maxBytes: 64 * 1_024 }));
    return dataResponse(await listRollouts());
  } catch (error: unknown) {
    return routeErrorResponse(error, "admin.rollouts.set", requestId);
  }
}
