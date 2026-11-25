import { visitRecordPatchSchema } from "@/server/contracts";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import {
  deleteDraftVisitRecord,
  editVisitRecord,
  getVisitRecord,
  shareVisitRecord,
  withdrawVisitRecord,
} from "@/server/visit-records";
import { requireFeature } from "@/server/business-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, route: RouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    await requireFeature(context, "records");
    return dataResponse(await getVisitRecord(context, (await route.params).id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.record.read", requestId);
  }
}

export async function PATCH(request: Request, route: RouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    await requireFeature(context, "records");
    const { id } = await route.params;
    const input = await parseJsonBody(request, visitRecordPatchSchema, { maxBytes: 64 * 1_024 });
    if (input.action === "share") await shareVisitRecord(context, id);
    else if (input.action === "withdraw") await withdrawVisitRecord(context, id);
    else await editVisitRecord(context, id, input);
    return dataResponse({ ok: true });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.record.update", requestId);
  }
}

export async function DELETE(request: Request, route: RouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    await requireFeature(context, "records");
    await deleteDraftVisitRecord(context, (await route.params).id);
    return dataResponse({ ok: true });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.record.delete", requestId);
  }
}
