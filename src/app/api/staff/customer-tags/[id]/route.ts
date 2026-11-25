import { customerIdSchema, tagUpdateSchema } from "@/lib/customer-contracts";
import { deleteTag, updateTag } from "@/server/customers/tags";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await updateTag(context, customerIdSchema.parse((await params).id), await parseJsonBody(request, tagUpdateSchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.customer.tags.update", requestId);
  }
}

export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await deleteTag(context, customerIdSchema.parse((await params).id)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.customer.tags.delete", requestId);
  }
}
