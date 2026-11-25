import { fieldDefinitionInputSchema } from "@/lib/customer-contracts";
import { createFieldDefinition, listFieldDefinitions } from "@/server/customers/fields";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const includeArchived = new URL(request.url).searchParams.get("archived") === "1";
    return dataResponse(await listFieldDefinitions(await getStaffContext(request.headers), { includeArchived }));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.customer.fields.list", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await createFieldDefinition(context, await parseJsonBody(request, fieldDefinitionInputSchema)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.customer.fields.create", requestId);
  }
}
