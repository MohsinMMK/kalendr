import { blockInputSchema, customerIdSchema } from "@/lib/customer-contracts";
import { blockCustomer, unblockCustomer } from "@/server/customers/block";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const input = await parseJsonBody(request, blockInputSchema);
    return dataResponse(await blockCustomer(context, customerIdSchema.parse((await params).id), input.reason));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.customer.block", requestId);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await unblockCustomer(context, customerIdSchema.parse((await params).id)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.customer.unblock", requestId);
  }
}
