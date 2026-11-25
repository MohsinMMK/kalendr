import { z } from "zod";

import { useCreditInputSchema } from "@/lib/offers-contracts";
import { ApiError } from "@/server/api-error";
import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { spendCreditOnAppointment } from "@/server/offers/packages";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

/** Pays an existing visit with one credit from the customer's package. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) throw new ApiError(404, "appointment_not_found", "That visit could not be found.");
    const idempotencyKey = getIdempotencyKey(request);
    const input = await parseJsonBody(request, useCreditInputSchema, { maxBytes: 500 });
    return dataResponse(await spendCreditOnAppointment(staff, id.data, input.customerPackageId, idempotencyKey), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.packages.use", requestId);
  }
}
