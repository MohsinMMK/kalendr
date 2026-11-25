import { bookingLinkInputSchema } from "@/lib/booking-links";
import { createBookingLink, listBookingLinks } from "@/server/booking-links";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The business's printed short links with their click counts. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await listBookingLinks(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.short_links.list", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await createBookingLink(context, await parseJsonBody(request, bookingLinkInputSchema)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.short_links.create", requestId);
  }
}
