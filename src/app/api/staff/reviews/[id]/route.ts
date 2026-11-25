import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { setReviewHidden } from "@/server/reviews";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const visibilitySchema = z.object({ hidden: z.boolean() }).strict();

interface ReviewRouteContext {
  params: Promise<{ id: string }>;
}

/** Hides a review from the public page, or shows it again. */
export async function PATCH(request: Request, context: ReviewRouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const parsed = idSchema.safeParse((await context.params).id);
    if (!parsed.success) throw new ApiError(404, "review_not_found", "Review not found.");
    const { hidden } = await parseJsonBody(request, visibilitySchema);
    await setReviewHidden(staff, parsed.data, hidden);
    return dataResponse({ id: parsed.data, hidden });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.review.visibility", requestId);
  }
}
