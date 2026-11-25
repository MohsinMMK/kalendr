import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { deleteCancelPreset } from "@/server/cancel-presets";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const parsed = idSchema.safeParse((await context.params).id);
    if (!parsed.success) throw new ApiError(404, "preset_not_found", "That cancellation reason no longer exists.");
    return dataResponse(await deleteCancelPreset(staff, parsed.data));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.cancel_presets.delete", requestId);
  }
}
