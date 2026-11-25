import { createGroup, groupInputSchema, listGroups } from "@/server/scim/groups";
import { scimRoute } from "@/server/scim/http";
import { scimBody, scimJson } from "@/server/scim/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return scimRoute(request, async (context, baseUrl) => scimJson(await listGroups(context, new URL(request.url), baseUrl)));
}

export async function POST(request: Request): Promise<Response> {
  return scimRoute(request, async (context, baseUrl) => scimJson(await createGroup(context, await scimBody(request, groupInputSchema), baseUrl), 201));
}
