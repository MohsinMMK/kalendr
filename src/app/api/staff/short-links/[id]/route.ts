import { z } from "zod";

import { deleteBookingLink } from "@/server/booking-links";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().min(1).max(64);

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    return dataResponse(await deleteBookingLink(staff, idSchema.parse((await context.params).id)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.short_links.delete", requestId);
  }
}
