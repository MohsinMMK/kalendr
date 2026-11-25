import { updateSessionSchema } from "@/lib/classes-contracts";
import { getSession, updateSessionCapacity } from "@/server/classes";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One session with its roster. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await getSession(context, (await params).id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.classes.read", requestId);
  }
}

/** Changes the seats. Version-checked; more seats go straight to the people waiting. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await updateSessionCapacity(context, (await params).id, await parseJsonBody(request, updateSessionSchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.classes.update", requestId);
  }
}
