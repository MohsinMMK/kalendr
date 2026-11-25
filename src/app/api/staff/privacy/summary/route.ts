import { dataResponse, routeErrorResponse } from "@/server/http";
import { getProcessingSummary } from "@/server/privacy/summary";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What the business collects, why, who receives it, and the retention settings. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await getProcessingSummary(context));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.privacy.summary", requestId);
  }
}
