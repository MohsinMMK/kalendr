import { ApiError } from "@/server/api-error";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { maxRecordFileBytes } from "@/lib/record-files";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { addVisitRecordFile } from "@/server/visit-records";
import { requireFeature } from "@/server/business-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, route: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    await requireFeature(context, "records");
    const declared = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
    if (declared > maxRecordFileBytes + 64 * 1_024) throw new ApiError(413, "request_too_large", "Files can be up to 15 MB.");
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(400, "validation_error", "Choose a file to upload.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    return dataResponse(await addVisitRecordFile(context, (await route.params).id, { name: file.name, bytes }), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.record.file.add", requestId);
  }
}
