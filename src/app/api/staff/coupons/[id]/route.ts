import { z } from "zod";

import { couponInputSchema } from "@/lib/offers-contracts";
import { ApiError } from "@/server/api-error";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { saveCoupon } from "@/server/offers/coupons";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) throw new ApiError(404, "coupon_not_found", "That code could not be found.");
    return dataResponse(await saveCoupon(staff, id.data, await parseJsonBody(request, couponInputSchema, { maxBytes: 4_000 })));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.coupons.update", requestId);
  }
}
