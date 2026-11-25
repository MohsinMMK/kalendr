import { z } from "zod";

import { copyScheduleToPerson } from "@/server/availability-admin";
import { optionalIdempotencyKey } from "@/server/availability-http";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const copySchema = z.object({
  toPractitionerId: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(80).optional(),
});

/** Copies this schedule's times and dates to another person. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { id } = await params;
    const input = await parseJsonBody(request, copySchema);
    return dataResponse(await copyScheduleToPerson(context, id, input, optionalIdempotencyKey(request)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.availability.schedules.copy", requestId);
  }
}
