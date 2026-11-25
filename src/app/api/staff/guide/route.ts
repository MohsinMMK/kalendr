import { z } from "zod";

import { getStaffGuide, saveStaffGuide } from "@/server/booking-guide";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The "help me choose" questions for the builder. `guide` is null when the business has not made any. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse({ guide: await getStaffGuide(context) });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.guide.read", requestId);
  }
}

/** Saves the questions. The body is checked against the guide rules in `saveStaffGuide`. Owners and admins only. */
export async function PATCH(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const input = await parseJsonBody(request, z.unknown(), { maxBytes: 64 * 1_024 });
    return dataResponse({ guide: await saveStaffGuide(context, input) });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.guide.save", requestId);
  }
}
