import { z } from "zod";

import { getAdminContext, requireAdminCapability } from "@/server/admin-context";
import { listAudit } from "@/server/admin/audit";
import { dataResponse, parseQuery, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  tenantId: z.string().trim().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const admin = await getAdminContext(request.headers);
    requireAdminCapability(admin, "readOverview");
    const query = parseQuery(request, querySchema);
    return dataResponse(await listAudit(admin.userId, query.tenantId ?? null, query.limit));
  } catch (error: unknown) {
    return routeErrorResponse(error, "admin.audit", requestId);
  }
}
