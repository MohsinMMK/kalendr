import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { confirmRecordAccess } from "@/server/visit-records";
import { requireFeature } from "@/server/business-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, route: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    await requireFeature(context, "records");
    await confirmRecordAccess(context, (await route.params).id);
    return dataResponse({ ok: true });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.record.access.confirm", requestId);
  }
}
