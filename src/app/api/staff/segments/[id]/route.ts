import { customerIdSchema } from "@/lib/customer-contracts";
import { segmentUpdateSchema } from "@/lib/segment-filter";
import { deleteSegment, getSegment, updateSegment } from "@/server/customers/segments";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await getSegment(await getStaffContext(request.headers), customerIdSchema.parse((await params).id)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.segments.get", requestId);
  }
}

export async function PUT(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await updateSegment(context, customerIdSchema.parse((await params).id), await parseJsonBody(request, segmentUpdateSchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.segments.update", requestId);
  }
}

export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await deleteSegment(context, customerIdSchema.parse((await params).id)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.segments.delete", requestId);
  }
}
