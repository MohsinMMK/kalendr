import { z } from "zod";

import { replaceAppCredentials } from "@/server/apps/admin";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request, route: { params: Promise<{ key: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    assertNotImpersonating(context);
    const { key } = await route.params;
    return dataResponse(await replaceAppCredentials(context, key, await parseJsonBody(request, z.unknown())), 200);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.apps.credentials", requestId);
  }
}
