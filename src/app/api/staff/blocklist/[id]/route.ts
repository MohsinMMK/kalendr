import { z } from "zod";

import { dataResponse, routeErrorResponse } from "@/server/http";
import { removeBlocklistEntry } from "@/server/spam";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { ApiError } from "@/server/api-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export async function DELETE(request: Request, route: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const id = idSchema.safeParse((await route.params).id);
    if (!id.success) throw new ApiError(404, "blocklist_entry_not_found", "That entry is already gone.");
    return dataResponse(await removeBlocklistEntry(context, id.data));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.blocklist.remove", requestId);
  }
}
