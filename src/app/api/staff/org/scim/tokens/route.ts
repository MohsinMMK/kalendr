import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, getStaffContext } from "@/server/staff-context";
import { scimTokenInputSchema } from "@/lib/enterprise-contracts";
import { createScimToken, listScimTokens } from "@/server/enterprise/scim-tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await listScimTokens(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.org.scim.tokens.list", requestId);
  }
}

/** The token is in this response and never again. Support sessions can't make one. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotImpersonating(context);
    return dataResponse(await createScimToken(context, await parseJsonBody(request, scimTokenInputSchema)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.org.scim.tokens.create", requestId);
  }
}
