import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { removeHandoverNote } from "@/server/handover-notes";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noteIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const parsed = noteIdSchema.safeParse((await context.params).id);
    if (!parsed.success) throw new ApiError(404, "handover_note_not_found", "That handover note is already gone.");
    return dataResponse(await removeHandoverNote(staff, parsed.data));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.handover.remove", requestId);
  }
}
