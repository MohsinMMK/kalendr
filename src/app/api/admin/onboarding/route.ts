import { z } from "zod";

import { getAdminContext, requireAdminCapability } from "@/server/admin-context";
import { onboardingFunnel } from "@/server/admin/onboarding";
import { dataResponse, parseQuery, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({ days: z.coerce.number().int().min(1).max(180).default(30) });

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const admin = await getAdminContext(request.headers);
    requireAdminCapability(admin, "readOverview");
    return dataResponse(await onboardingFunnel(admin.userId, parseQuery(request, querySchema).days));
  } catch (error: unknown) {
    return routeErrorResponse(error, "admin.onboarding", requestId);
  }
}
