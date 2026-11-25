import { pageQuerySchema, listResult, v1Route } from "@/server/api-v1";
import { listServices } from "@/server/api-v1-reads";
import { parseQuery } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = v1Route("v1.services.list", "services:read", async ({ request, context }) => {
  const { limit, cursor } = parseQuery(request, pageQuerySchema);
  const page = await listServices(context.tenantId, limit, cursor);
  return listResult(page.items, page.nextCursor);
});
