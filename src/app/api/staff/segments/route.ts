import { segmentInputSchema } from "@/lib/segment-filter";
import { createSegment, listSegments } from "@/server/customers/segments";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await listSegments(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.segments.list", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await createSegment(context, await parseJsonBody(request, segmentInputSchema)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.segments.create", requestId);
  }
}
