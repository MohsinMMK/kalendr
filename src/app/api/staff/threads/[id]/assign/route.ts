import { z } from "zod";

import { assignInput } from "@/lib/inbox-contracts";
import { ApiError } from "@/server/api-error";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { assignThread } from "@/server/threads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);

/** Hands a conversation to one person, or back to everyone with `{ "userId": null }`. */
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) throw new ApiError(404, "thread_not_found", "That conversation was not found.");
    const input = await parseJsonBody(request, assignInput);
    return dataResponse(await assignThread(staff, id.data, input.userId));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.threads.assign", requestId);
  }
}
