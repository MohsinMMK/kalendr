import { patchSchema, scimBody, scimJson } from "@/server/scim/protocol";
import { scimRoute } from "@/server/scim/http";
import { getUser, patchUser, removeUser, replaceUser, userInputSchema } from "@/server/scim/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
  return scimRoute(request, async (context, baseUrl) => scimJson(await getUser(context, (await params).id, baseUrl)));
}

export async function PUT(request: Request, { params }: Params): Promise<Response> {
  return scimRoute(request, async (context, baseUrl) => scimJson(await replaceUser(context, (await params).id, await scimBody(request, userInputSchema), baseUrl)));
}

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  return scimRoute(request, async (context, baseUrl) => scimJson(await patchUser(context, (await params).id, (await scimBody(request, patchSchema)).Operations, baseUrl)));
}

/** Deactivates. Nothing a directory does here deletes a booking, a record or a history entry. */
export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  return scimRoute(request, async (context) => {
    await removeUser(context, (await params).id);
    return scimJson(null, 204);
  });
}
