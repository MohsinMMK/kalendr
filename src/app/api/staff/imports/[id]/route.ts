import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { importUpdateInput } from "@/server/imports/contracts";
import { importIdOf, deleteImport, getImport, updateImport } from "@/server/imports/service";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Route = { params: Promise<{ id: string }> };

export async function GET(request: Request, route: Route): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await getImport(await getStaffContext(request.headers), importIdOf((await route.params).id)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.imports.get", requestId);
  }
}

/** Saves which column is which and the choices, and returns the first five rows as they will be saved. */
export async function PATCH(request: Request, route: Route): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const id = importIdOf((await route.params).id);
    return dataResponse(await updateImport(context, id, await parseJsonBody(request, importUpdateInput, { maxBytes: 64 * 1024 })));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.imports.update", requestId);
  }
}

export async function DELETE(request: Request, route: Route): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    return dataResponse(await deleteImport(staff, importIdOf((await route.params).id)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.imports.delete", requestId);
  }
}
