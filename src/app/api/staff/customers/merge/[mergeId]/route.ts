import { customerIdSchema } from "@/lib/customer-contracts";
import { undoMerge } from "@/server/customers/merge";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Undoes a merge made in the last 30 days. */
export async function DELETE(request: Request, { params }: { params: Promise<{ mergeId: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await undoMerge(context, customerIdSchema.parse((await params).mergeId)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.customer.merge.undo", requestId);
  }
}
