import { z } from "zod";

import { createApiKey, listApiKeys } from "@/server/api-keys-admin";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await listApiKeys(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.api_keys.list", requestId);
  }
}

/** Owner only, and needs a second-factor check from the last 10 minutes. The key comes back once, in `secret`. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    assertNotImpersonating(context);
    // The body is checked inside createApiKey after the permission and step-up checks, so a refused person learns nothing about the rules.
    const body = await parseJsonBody(request, z.unknown());
    return dataResponse(await createApiKey(context, body), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.api_keys.create", requestId);
  }
}
