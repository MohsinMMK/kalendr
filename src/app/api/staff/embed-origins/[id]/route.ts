import { removeEmbedOrigin } from "@/server/domains/service";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stops allowing a website. Pages already open on it stop framing the widget after their next load. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await removeEmbedOrigin(context, (await params).id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.embed_origins.remove", requestId);
  }
}
