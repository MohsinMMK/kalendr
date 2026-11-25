import { sellPackageInputSchema } from "@/lib/offers-contracts";
import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { sellPackage } from "@/server/offers/packages";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sells a package at the desk: an invoice, the payments taken and the credits, together. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const idempotencyKey = getIdempotencyKey(request);
    return dataResponse(await sellPackage(staff, await parseJsonBody(request, sellPackageInputSchema, { maxBytes: 4_000 }), idempotencyKey), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.packages.sell", requestId);
  }
}
