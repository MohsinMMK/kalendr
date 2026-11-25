import { dataResponse, routeErrorResponse } from "@/server/http";
import { createImport, listImports } from "@/server/imports/service";
import { readImportUpload } from "@/server/imports/upload";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await listImports(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.imports.list", requestId);
  }
}

/** Upload a customer, service or appointment file (multipart: file, kind). Stored encrypted; nothing is imported yet. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const upload = await readImportUpload(request);
    return dataResponse(await createImport(context, upload), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.imports.create", requestId);
  }
}
