import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { markThreadRead } from "@/server/threads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);

/** Staff opened the conversation: clear its unread count. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) throw new ApiError(404, "thread_not_found", "That conversation was not found.");
    return dataResponse(await markThreadRead(staff, id.data));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.threads.read", requestId);
  }
}
