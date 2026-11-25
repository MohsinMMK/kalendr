import { paymentPolicySchema } from "@/lib/payments";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { savePaymentPolicy } from "@/server/payments/accounts";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The three plain settings every customer sees before they pay. */
export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    return dataResponse(await savePaymentPolicy(staff, await parseJsonBody(request, paymentPolicySchema, { maxBytes: 1_000 })));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.payment_policy.save", requestId);
  }
}
