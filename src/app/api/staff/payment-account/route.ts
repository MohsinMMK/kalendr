import { paymentAccountInputSchema } from "@/lib/payments";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { appOrigin, connectPaymentAccount, disconnectPaymentAccount } from "@/server/payments/accounts";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Connects the business's own payment account. The keys are tested, then sealed; they are never shown again. */
export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    assertNotImpersonating(staff);
    return dataResponse(await connectPaymentAccount(staff, await parseJsonBody(request, paymentAccountInputSchema, { maxBytes: 4_000 }), appOrigin(request)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.payment_account.connect", requestId);
  }
}

/** Turns online payment off and forgets the keys. */
export async function DELETE(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    assertNotImpersonating(staff);
    await disconnectPaymentAccount(staff);
    return dataResponse({ disconnected: true });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.payment_account.disconnect", requestId);
  }
}
