import { customerIdSchema } from "@/lib/customer-contracts";
import { segmentMembersQuerySchema } from "@/lib/segment-filter";
import { getSegment, listSegmentMembers } from "@/server/customers/segments";
import { dataResponse, parseQuery, routeErrorResponse } from "@/server/http";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    const query = parseQuery(request, segmentMembersQuerySchema);
    const segment = await getSegment(context, customerIdSchema.parse((await params).id));
    return dataResponse(await listSegmentMembers(context, segment.filter, query));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.segments.members", requestId);
  }
}
