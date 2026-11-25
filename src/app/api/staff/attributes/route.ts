import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { attributeDefinitionSchema } from "@/lib/enterprise-contracts";
import { createAttribute, listAttributes, listPersonAttributes } from "@/server/enterprise/attributes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse({ attributes: await listAttributes(context), people: await listPersonAttributes(context) }, 200);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.attributes.list", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await createAttribute(context, await parseJsonBody(request, attributeDefinitionSchema)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.attributes.create", requestId);
  }
}
