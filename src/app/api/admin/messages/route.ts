import { z } from "zod";

import { getAdminContext, requireAdminCapability } from "@/server/admin-context";
import { findMessages } from "@/server/admin/messages";
import { dataResponse, parseQuery, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({ id: z.string().trim().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/) });

/** Find a message by its id or its appointment's id: statuses, codes and a sentence, never a name or an address. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const admin = await getAdminContext(request.headers);
    requireAdminCapability(admin, "findMessages");
    return dataResponse(await findMessages(admin.userId, parseQuery(request, querySchema).id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "admin.messages.find", requestId);
  }
}
