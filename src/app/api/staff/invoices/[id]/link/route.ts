import { invoiceLinkInputSchema } from "@/lib/invoicing-contracts";
import { ApiError } from "@/server/api-error";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { createInvoiceLink } from "@/server/invoicing/links";
import { appOrigin } from "@/server/payments/accounts";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A fresh link the customer opens to get the PDF. Sending it by message needs an approved template, so staff copy it. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const id = (await context.params).id;
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new ApiError(404, "invoice_not_found", "That invoice could not be found.");
    const input = await parseJsonBody(request, invoiceLinkInputSchema, { maxBytes: 500 });
    return dataResponse(await createInvoiceLink(staff, id, input.creditNoteId ?? null, appOrigin(request)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.invoices.link", requestId);
  }
}
