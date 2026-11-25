import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { getStaffContext } from "@/server/staff-context";
import { getThread } from "@/server/threads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const threadIdSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);

/** One conversation with its messages and the customer's next booking. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    const id = threadIdSchema.safeParse((await context.params).id);
    if (!id.success) throw new ApiError(404, "thread_not_found", "That conversation was not found.");
    return dataResponse(await getThread(staff, id.data));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.threads.get", requestId);
  }
}
