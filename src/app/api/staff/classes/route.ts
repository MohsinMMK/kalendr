import { z } from "zod";

import { createSessionsSchema } from "@/lib/classes-contracts";
import { createSessions, listSessions } from "@/server/classes";
import { dataResponse, parseJsonBody, parseQuery, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const rangeSchema = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  serviceId: z.string().min(1).max(160).optional(),
});

/** The sessions that start in a range, with seats taken and people waiting. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    const query = parseQuery(request, rangeSchema);
    return dataResponse(await listSessions(context, { from: new Date(query.from), to: new Date(query.to), ...(query.serviceId ? { serviceId: query.serviceId } : {}) }));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.classes.list", requestId);
  }
}

/** Creates one session, or a repeating timetable. When any date clashes nothing is created and the clashes come back. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const result = await createSessions(context, await parseJsonBody(request, createSessionsSchema));
    return dataResponse(result, result.clashes.length > 0 ? 409 : 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.classes.create", requestId);
  }
}
