import { visitRecordInputSchema } from "@/server/contracts";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { createVisitRecord, listVisitRecords } from "@/server/visit-records";
import { requireFeature } from "@/server/business-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    await requireFeature(context, "records");
    const patientId = new URL(request.url).searchParams.get("patientId") ?? undefined;
    return dataResponse(await listVisitRecords(context, patientId));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.record.list", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    await requireFeature(context, "records");
    const input = await parseJsonBody(request, visitRecordInputSchema, { maxBytes: 64 * 1_024 });
    return dataResponse(await createVisitRecord(context, input), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.record.create", requestId);
  }
}
