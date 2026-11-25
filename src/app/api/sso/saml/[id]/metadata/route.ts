import { samlMetadata } from "@/server/enterprise/saml";
import { resolveSsoConnection } from "@/server/enterprise/sso-login";
import { routeErrorResponse } from "@/server/http";
import { ApiError } from "@/server/api-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public. The provider-facing description of Kalendr as a SAML service: its address, reply address and name format. No secrets. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const { id } = await params;
    if (!(await resolveSsoConnection(id))) throw new ApiError(404, "not_found", "That connection could not be found.");
    return new Response(samlMetadata({ id }), { headers: { "content-type": "application/samlmetadata+xml; charset=utf-8", "cache-control": "no-store" } });
  } catch (error: unknown) {
    return routeErrorResponse(error, "sso.saml.metadata", requestId);
  }
}
