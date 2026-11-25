import { z } from "zod";

import { segmentFilterSchema } from "@/lib/segment-filter";
import { previewSegmentCount } from "@/server/customers/segments";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How many customers a filter selects, while the owner is still building it. Reads only, so it is not a write. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const input = await parseJsonBody(request, z.strictObject({ filter: segmentFilterSchema }));
    return dataResponse(await previewSegmentCount(context, input.filter));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.segments.preview", requestId);
  }
}
