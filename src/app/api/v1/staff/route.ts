import { pageQuerySchema, listResult, v1Route } from "@/server/api-v1";
import { listStaff } from "@/server/api-v1-reads";
import { parseQuery } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = v1Route("v1.staff.list", "staff:read", async ({ request, context }) => {
  const { limit, cursor } = parseQuery(request, pageQuerySchema);
  const page = await listStaff(context.tenantId, limit, cursor);
  return listResult(page.items, page.nextCursor);
});
