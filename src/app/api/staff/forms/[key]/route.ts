import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { updateStaffForm } from "@/server/booking-forms";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const formKeySchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/);

/** Saves a change to a form as its next version. Answers already given keep the version they answered. */
export async function PATCH(request: Request, route: { params: Promise<{ key: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const key = formKeySchema.safeParse((await route.params).key);
    if (!key.success) throw new ApiError(404, "form_not_found", "Form not found.");
    const input = await parseJsonBody(request, z.unknown(), { maxBytes: 64 * 1_024 });
    return dataResponse(await updateStaffForm(context, key.data, input));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.form.update", requestId);
  }
}
