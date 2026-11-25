import { tagInputSchema } from "@/lib/customer-contracts";
import { createTag, listTags } from "@/server/customers/tags";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await listTags(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.customer.tags.catalogue", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await createTag(context, await parseJsonBody(request, tagInputSchema)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.customer.tags.create", requestId);
  }
}
