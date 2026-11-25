import { scimRoute } from "@/server/scim/http";
import { scimJson } from "@/server/scim/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What this directory service supports, so a directory tool can set itself up. */
export async function GET(request: Request): Promise<Response> {
  return scimRoute(request, async (_context, baseUrl) => scimJson({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer token", description: "A directory token made in Kalendr, Organisation, Provisioning.", primary: true }],
    meta: { resourceType: "ServiceProviderConfig", location: `${baseUrl}/ServiceProviderConfig` },
  }));
}
