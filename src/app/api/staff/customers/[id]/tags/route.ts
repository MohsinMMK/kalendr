import { customerIdSchema, customerTagsInputSchema } from "@/lib/customer-contracts";
import { customerTagsFor, setCustomerTags } from "@/server/customers/tags";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await customerTagsFor(context, customerIdSchema.parse((await params).id)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.customer.tags.list", requestId);
  }
}

/** Replaces the customer's tags with exactly the set sent. Sending the same set again changes nothing, so it needs no Idempotency-Key. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const input = await parseJsonBody(request, customerTagsInputSchema);
    return dataResponse(await setCustomerTags(context, customerIdSchema.parse((await params).id), input.tagIds));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.customer.tags.set", requestId);
  }
}
