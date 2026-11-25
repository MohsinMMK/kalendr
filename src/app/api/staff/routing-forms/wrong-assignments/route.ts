import { z } from "zod";

import { wrongAssignmentSchema } from "@/lib/routing-forms";
import { dataResponse, parseJsonBody, parseQuery, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { listWrongAssignments, reportWrongAssignment } from "@/server/routing-forms/wrong-assignment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    const { status } = parseQuery(request, z.object({ status: z.enum(["open", "all"]).default("open") }));
    return dataResponse(await listWrongAssignments(context, status));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.routing_forms.wrong.list", requestId);
  }
}

/** "This booking should have gone to someone else." Any staff member with the flag permission can send it. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await reportWrongAssignment(context, await parseJsonBody(request, wrongAssignmentSchema)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.routing_forms.wrong.report", requestId);
  }
}
