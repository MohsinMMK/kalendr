import { customerIdSchema, timelineQuerySchema } from "@/lib/customer-contracts";
import { loadTimeline } from "@/server/customers/timeline";
import { dataResponse, parseQuery, routeErrorResponse } from "@/server/http";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    const query = parseQuery(request, timelineQuerySchema);
    return dataResponse(await loadTimeline(context, customerIdSchema.parse((await params).id), query));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.customer.timeline", requestId);
  }
}
