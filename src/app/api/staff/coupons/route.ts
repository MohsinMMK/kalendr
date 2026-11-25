import { couponInputSchema } from "@/lib/offers-contracts";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { saveCoupon } from "@/server/offers/coupons";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    return dataResponse(await saveCoupon(staff, null, await parseJsonBody(request, couponInputSchema, { maxBytes: 4_000 })), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.coupons.create", requestId);
  }
}
