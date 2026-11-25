import { dataResponse, routeErrorResponse } from "@/server/http";
import { appOrigin, getPaymentSettings } from "@/server/payments/accounts";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The business's payment account (never its keys), its policy, and which providers can be connected here. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await getPaymentSettings(await getStaffContext(request.headers), appOrigin(request)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.payment_settings.get", requestId);
  }
}
