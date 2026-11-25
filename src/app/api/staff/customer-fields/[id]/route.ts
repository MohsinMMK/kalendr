import { customerIdSchema, fieldDefinitionUpdateSchema } from "@/lib/customer-contracts";
import { updateFieldDefinition } from "@/server/customers/fields";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Answers `{ definition, cleared }`: the field as it is now and how many saved answers no longer fit and were removed. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await updateFieldDefinition(context, customerIdSchema.parse((await params).id), await parseJsonBody(request, fieldDefinitionUpdateSchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.customer.fields.update", requestId);
  }
}
