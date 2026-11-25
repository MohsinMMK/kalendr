import { servicePaymentSchema } from "@/lib/payments";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { getServicePayment, saveServicePayment } from "@/server/payments/accounts";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Context { params: Promise<{ id: string }> }

export async function GET(request: Request, context: Context): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await getServicePayment(await getStaffContext(request.headers), (await context.params).id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.service_payment.get", requestId);
  }
}

/** Price, payment mode and deposit of one service. */
export async function PUT(request: Request, context: Context): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    return dataResponse(await saveServicePayment(staff, (await context.params).id, await parseJsonBody(request, servicePaymentSchema, { maxBytes: 1_000 })));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.service_payment.save", requestId);
  }
}
