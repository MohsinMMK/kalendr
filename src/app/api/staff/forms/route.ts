import { z } from "zod";

import { createStaffForm, listStaffForms } from "@/server/booking-forms";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await listStaffForms(context));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.form.list", requestId);
  }
}

/** Creates a booking form. The body is checked against the form rules in `createStaffForm`. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const input = await parseJsonBody(request, z.unknown(), { maxBytes: 64 * 1_024 });
    return dataResponse(await createStaffForm(context, input), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.form.create", requestId);
  }
}
