import { getGroup, groupInputSchema, patchGroup, removeGroup, replaceGroup } from "@/server/scim/groups";
import { scimRoute } from "@/server/scim/http";
import { patchSchema, scimBody, scimJson } from "@/server/scim/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
  return scimRoute(request, async (context, baseUrl) => scimJson(await getGroup(context, (await params).id, baseUrl)));
}

export async function PUT(request: Request, { params }: Params): Promise<Response> {
  return scimRoute(request, async (context, baseUrl) => scimJson(await replaceGroup(context, (await params).id, await scimBody(request, groupInputSchema), baseUrl)));
}

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  return scimRoute(request, async (context, baseUrl) => scimJson(await patchGroup(context, (await params).id, (await scimBody(request, patchSchema)).Operations, baseUrl)));
}

export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  return scimRoute(request, async (context) => {
    await removeGroup(context, (await params).id);
    return scimJson(null, 204);
  });
}
