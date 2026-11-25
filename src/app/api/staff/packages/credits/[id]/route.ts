import { z } from "zod";

import { adjustCreditsInputSchema } from "@/lib/offers-contracts";
import { ApiError } from "@/server/api-error";
import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { adjustCredits } from "@/server/offers/packages";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

/** Adds or takes away credits by hand, with a reason. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) throw new ApiError(404, "package_not_found", "That package could not be found.");
    const idempotencyKey = getIdempotencyKey(request);
    return dataResponse(await adjustCredits(staff, id.data, await parseJsonBody(request, adjustCreditsInputSchema, { maxBytes: 1_000 }), idempotencyKey), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.packages.adjust", requestId);
  }
}
