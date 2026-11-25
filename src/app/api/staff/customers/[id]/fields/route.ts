import { customerFieldValuesInputSchema, customerIdSchema } from "@/lib/customer-contracts";
import { fieldValuesFor, setFieldValues } from "@/server/customers/fields";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await fieldValuesFor(context, customerIdSchema.parse((await params).id)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.customer.fields.get", requestId);
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const input = await parseJsonBody(request, customerFieldValuesInputSchema);
    return dataResponse(await setFieldValues(context, customerIdSchema.parse((await params).id), input.values));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.customer.fields.set", requestId);
  }
}
