import { z } from "zod";

import { getAppDetail, uninstallApp, updateAppSettings } from "@/server/apps/admin";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Route = { params: Promise<{ key: string }> };

export async function GET(request: Request, route: Route): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await getAppDetail(await getStaffContext(request.headers), (await route.params).key));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.apps.get", requestId);
  }
}

/** Changes the app's choices. The body is checked against the app's own schema inside. */
export async function PATCH(request: Request, route: Route): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await updateAppSettings(context, (await route.params).key, await parseJsonBody(request, z.unknown())));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.apps.update", requestId);
  }
}

export async function DELETE(request: Request, route: Route): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    assertNotImpersonating(context);
    return dataResponse(await uninstallApp(context, (await route.params).key), 202);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.apps.uninstall", requestId);
  }
}
