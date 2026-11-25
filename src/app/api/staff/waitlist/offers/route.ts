import { getStaffContext } from "@/server/staff-context";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { getWaitlistOffers } from "@/server/waitlist-staff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Each open time's offer trail, the order rule and the per-service switches (feature 21). */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await getWaitlistOffers(context));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.waitlist.offers", requestId);
  }
}
