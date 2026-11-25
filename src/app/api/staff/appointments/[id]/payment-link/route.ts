import { ApiError } from "@/server/api-error";
import { paymentLinkInputSchema } from "@/lib/payments";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { appOrigin } from "@/server/payments/accounts";
import { createPaymentLink } from "@/server/payments/checkout";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A pay link for a booking that still owes money. Calls no provider: the checkout is made when the customer opens it. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const input = await parseJsonBody(request, paymentLinkInputSchema, { maxBytes: 500 });
    // Sending by message needs an approved message template, which belongs to the messaging work. Until then the desk copies the link.
    if (input.send) throw new ApiError(409, "send_unavailable", "Sending the link by message isn't set up yet. Copy the link and send it yourself.");
    const link = await createPaymentLink(staff, (await context.params).id, appOrigin(request));
    return dataResponse({ ...link, sent: false }, 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.payment_link.create", requestId);
  }
}
