import { customerIdSchema } from "@/lib/customer-contracts";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { loadCustomerSummary } from "@/server/customers/profile";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await loadCustomerSummary(context, customerIdSchema.parse((await params).id)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.customer.summary", requestId);
  }
}
