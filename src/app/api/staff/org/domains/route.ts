import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, getStaffContext } from "@/server/staff-context";
import { domainInputSchema } from "@/lib/enterprise-contracts";
import { addDomain, listDomains } from "@/server/enterprise/domains";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await listDomains(context), 200);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.org.domains.list", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotImpersonating(context);
    return dataResponse(await addDomain(context, await parseJsonBody(request, domainInputSchema)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.org.domains.add", requestId);
  }
}
