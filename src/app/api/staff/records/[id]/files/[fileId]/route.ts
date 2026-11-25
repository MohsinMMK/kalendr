import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { readStaffRecordFile, recordFileResponse, removeVisitRecordFile } from "@/server/visit-records";
import { requireFeature } from "@/server/business-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string; fileId: string }>;
}

export async function GET(request: Request, route: RouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    await requireFeature(context, "records");
    const { id, fileId } = await route.params;
    return recordFileResponse(await readStaffRecordFile(context, id, fileId), new URL(request.url).searchParams.has("download"));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.record.file.read", requestId);
  }
}

export async function DELETE(request: Request, route: RouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    await requireFeature(context, "records");
    const { id, fileId } = await route.params;
    await removeVisitRecordFile(context, id, fileId);
    return dataResponse({ ok: true });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.record.file.remove", requestId);
  }
}
