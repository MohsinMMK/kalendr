import { z } from "zod";

import { createFeed, revokeFeed } from "@/server/calendar-sync";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Makes a new private feed address. It is shown once; any older address stops working. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    assertNotImpersonating(context);
    await parseJsonBody(request, z.object({}), { maxBytes: 200 });
    return dataResponse(await createFeed(context), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.calendars.feed.create", requestId);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    assertNotImpersonating(context);
    await parseJsonBody(request, z.object({}), { maxBytes: 200 });
    return dataResponse(await revokeFeed(context));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.calendars.feed.revoke", requestId);
  }
}
