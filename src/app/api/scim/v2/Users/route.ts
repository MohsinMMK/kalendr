import { scimJson, scimBody } from "@/server/scim/protocol";
import { scimRoute } from "@/server/scim/http";
import { createUser, listUsers, userInputSchema } from "@/server/scim/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return scimRoute(request, async (context, baseUrl) => scimJson(await listUsers(context, new URL(request.url), baseUrl)));
}

export async function POST(request: Request): Promise<Response> {
  return scimRoute(request, async (context, baseUrl) => scimJson(await createUser(context, await scimBody(request, userInputSchema), baseUrl), 201));
}
