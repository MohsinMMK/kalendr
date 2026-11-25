import { getDataProtectionStatus, rotateBusinessKey, rotateInput } from "@/server/data-protection";
import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The business's key version and file-check status: counts only. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await getDataProtectionStatus(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.settings.data_protection", requestId);
  }
}

/** "Replace key now": a new data key for the business. Older data is re-encrypted by the worker. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    assertNotImpersonating(staff);
    const idempotencyKey = getIdempotencyKey(request);
    const input = await parseJsonBody(request, rotateInput);
    return dataResponse(await rotateBusinessKey(staff, input, idempotencyKey));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.settings.data_protection.rotate", requestId);
  }
}
