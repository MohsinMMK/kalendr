import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { deleteCombinedLink } from "@/server/special-links";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export async function DELETE(request: Request, route: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const id = idSchema.safeParse((await route.params).id);
    if (!id.success) throw new ApiError(404, "combined_link_not_found", "That link no longer exists.");
    return dataResponse(await deleteCombinedLink(context, id.data));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.combined-links.delete", requestId);
  }
}
