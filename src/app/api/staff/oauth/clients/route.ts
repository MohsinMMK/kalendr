import { z } from "zod";

import { createClient, listClients } from "@/server/oauth/clients";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await listClients(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.oauth_clients.list", requestId);
  }
}

/** Owner only, behind a fresh second-factor check. The secret comes back once. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    assertNotImpersonating(context);
    return dataResponse(await createClient(context, await parseJsonBody(request, z.unknown())), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.oauth_clients.create", requestId);
  }
}
