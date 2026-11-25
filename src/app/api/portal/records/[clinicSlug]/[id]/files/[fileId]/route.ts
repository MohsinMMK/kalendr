import { routeErrorResponse } from "@/server/http";
import { requirePatientAccount } from "@/server/patient-auth";
import { readPortalRecordFile } from "@/server/patient-portal";
import { recordFileResponse } from "@/server/visit-records";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ clinicSlug: string; id: string; fileId: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const { clinicSlug, id, fileId } = await context.params;
    const file = await readPortalRecordFile(await requirePatientAccount(request.headers), clinicSlug, id, fileId);
    return recordFileResponse(file, new URL(request.url).searchParams.has("download"));
  } catch (error: unknown) {
    return routeErrorResponse(error, "portal.record.file", requestId);
  }
}
