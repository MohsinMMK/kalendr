import { dataResponse, routeErrorResponse } from "@/server/http";
import { deleteMedia } from "@/server/media";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request, route: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await deleteMedia(context, (await route.params).id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.media.delete", requestId);
  }
}
