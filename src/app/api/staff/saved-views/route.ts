import { z } from "zod";

import { savedViewInputSchema } from "@/lib/bookings-list";
import { ApiError } from "@/server/api-error";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { createSavedView, deleteSavedView, listSavedViews } from "@/server/saved-views";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await listSavedViews(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.saved_views.list", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await createSavedView(context, await parseJsonBody(request, savedViewInputSchema)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.saved_views.create", requestId);
  }
}

const idSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

/** `DELETE /api/staff/saved-views?id=...` */
export async function DELETE(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const id = idSchema.safeParse(new URL(request.url).searchParams.get("id"));
    if (!id.success) throw new ApiError(404, "view_not_found", "That view no longer exists, or it is not yours to remove.");
    return dataResponse(await deleteSavedView(context, id.data));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.saved_views.delete", requestId);
  }
}
