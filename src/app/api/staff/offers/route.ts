import { dataResponse, routeErrorResponse } from "@/server/http";
import { listCoupons } from "@/server/offers/coupons";
import { listPlans } from "@/server/offers/memberships";
import { listPackages } from "@/server/offers/packages";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Everything on sale and every code, for the Offers screen. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    const [packages, plans, coupons] = await Promise.all([listPackages(staff), listPlans(staff), listCoupons(staff)]);
    return dataResponse({ packages, plans, coupons });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.offers.list", requestId);
  }
}
