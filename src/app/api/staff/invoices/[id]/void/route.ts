import { ApiError } from "@/server/api-error";
import { routeErrorResponse } from "@/server/http";
import { voidInvoice } from "@/server/invoicing/invoice";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Always refused for an issued invoice, with the plain reason and what to do instead (a credit note). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const id = (await context.params).id;
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new ApiError(404, "invoice_not_found", "That invoice could not be found.");
    return await voidInvoice(staff, id);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.invoices.void", requestId);
  }
}
