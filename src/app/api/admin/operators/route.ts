import { operatorInputSchema } from "@/lib/admin-contracts";
import { ApiError } from "@/server/api-error";
import { getAdminContext, requireAdminCapability, requireAdminStepUp } from "@/server/admin-context";
import { listOperators, setOperator } from "@/server/admin/operators";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const admin = await getAdminContext(request.headers);
    requireAdminCapability(admin, "manageOperators");
    return dataResponse(await listOperators(admin.userId));
  } catch (error: unknown) {
    return routeErrorResponse(error, "admin.operators.list", requestId);
  }
}

/** Adds or changes an operator by the email of an existing user (super only, with a fresh code). Repeating it changes nothing. */
export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const admin = await getAdminContext(request.headers);
    requireAdminCapability(admin, "manageOperators");
    requireAdminStepUp(admin);
    const done = await setOperator(admin.userId, await parseJsonBody(request, operatorInputSchema));
    if (!done) throw new ApiError(404, "user_not_found", "No one has an account with that email yet. They must sign up first.");
    return dataResponse(await listOperators(admin.userId));
  } catch (error: unknown) {
    return routeErrorResponse(error, "admin.operators.set", requestId);
  }
}
