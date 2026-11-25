import { oneResult, v1Route } from "@/server/api-v1";
import { extensionCreateLink, extensionLinkBody } from "@/server/extension-api";
import { parseJsonBody } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = v1Route("ext.single_use_links", "links:write", async ({ request, context }) => {
  const body = await parseJsonBody(request, extensionLinkBody);
  return oneResult(await extensionCreateLink(context, body), 201);
});
