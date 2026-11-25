import { walkInSchema } from "@/lib/classes-contracts";
import { addWalkIn } from "@/server/classes";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Adds someone at the door to the roster. A full class stays full. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await addWalkIn(context, (await params).id, await parseJsonBody(request, walkInSchema)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.classes.walk_in", requestId);
  }
}
