import { classTypeSchema } from "@/lib/classes-contracts";
import { createClassType, listClassTypes } from "@/server/classes";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The active classes, for the "New session" form. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await listClassTypes(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.classes.type.list", requestId);
  }
}

/** Adds a class: a service with seats. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await createClassType(context, await parseJsonBody(request, classTypeSchema)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.classes.type.create", requestId);
  }
}
