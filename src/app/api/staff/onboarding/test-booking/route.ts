import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { findTestBooking, testBookingQuerySchema } from "@/server/onboarding/test-data";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Looks for the booking the owner just made on their own page (their own email, made since the panel opened), flags it as
 * a test, and says how its confirmation is going. The panel asks again every few seconds until it is found.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { since } = await parseJsonBody(request, testBookingQuerySchema);
    return dataResponse(await findTestBooking(context, since));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.onboarding.test_booking", requestId);
  }
}
