import { invoiceListQuerySchema, issueInvoiceInputSchema } from "@/lib/invoicing-contracts";
import { dataResponse, getIdempotencyKey, parseJsonBody, parseQuery, routeErrorResponse } from "@/server/http";
import { issueVisitInvoice, listInvoices } from "@/server/invoicing/invoice";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Invoices for the billing screen, newest first, with where each one stands. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    return dataResponse(await listInvoices(staff, parseQuery(request, invoiceListQuerySchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.invoices.list", requestId);
  }
}

/** Issues the numbered invoice or receipt for a visit. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const idempotencyKey = getIdempotencyKey(request);
    const input = await parseJsonBody(request, issueInvoiceInputSchema, { maxBytes: 2_000 });
    return dataResponse(await issueVisitInvoice(staff, input, idempotencyKey), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.invoices.issue", requestId);
  }
}
