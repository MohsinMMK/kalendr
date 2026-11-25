import { packageInputSchema } from "@/lib/offers-contracts";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { savePackage } from "@/server/offers/packages";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Puts a new package on sale. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    return dataResponse(await savePackage(staff, null, await parseJsonBody(request, packageInputSchema, { maxBytes: 4_000 })), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.packages.create", requestId);
  }
}
